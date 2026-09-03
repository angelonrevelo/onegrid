import { describe, expect, it } from 'vitest';
import type { ComparisonFilter, LogicalFilter, Schema } from '@onegrid/protocol';
import {
  addCondition,
  addNode,
  countCondition,
  describeQuery,
  emptyQuery,
  fromFilterModel,
  isCondition,
  isGroup,
  isProtocolExpressible,
  moveNode,
  nodeAt,
  operatorArity,
  operatorForType,
  operatorLabel,
  QueryCompileError,
  removeNode,
  resolveDuration,
  setGroupOperator,
  toFilterModel,
  toMongo,
  toSql,
  ungroup,
  updateCondition,
  validateQuery,
  wrapInGroup,
  type NodePath,
  type QueryCondition,
  type QueryGroup,
  type SqlDialect,
} from '../index.js';

const SCHEMA: Schema = [
  { id: 'name', type: 'utf8', displayName: 'Name' },
  { id: 'price', type: 'float64', displayName: 'Price' },
  { id: 'quantity', type: 'int32', displayName: 'Quantity' },
  { id: 'created', type: 'timestamp', displayName: 'Created' },
  { id: 'active', type: 'bool', displayName: 'Active' },
  { id: 'payload', type: 'json', displayName: 'Payload' },
];

const NOW = new Date('2026-09-04T12:00:00.000Z');

function condition(partial: Omit<QueryCondition, 'kind'>): QueryCondition {
  return { kind: 'condition', ...partial };
}

function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

// -----------------------------------------------------------------------------

describe('operator catalogue', () => {
  it('offers the date set for a timestamp column', () => {
    const operator = operatorForType('timestamp');
    expect(operator).toContain('before');
    expect(operator).toContain('after');
    expect(operator).toContain('between');
    expect(operator).toContain('inLast');
    expect(operator).toContain('isNull');
    expect(operator).not.toContain('contains');
  });

  it('offers the text set for a utf8 column', () => {
    const operator = operatorForType('utf8');
    for (const wanted of ['contains', 'startsWith', 'endsWith', 'matches', 'in'] as const) {
      expect(operator).toContain(wanted);
    }
    expect(operator).not.toContain('lt');
    expect(operator).not.toContain('inLast');
  });

  it('offers the comparison set for every numeric width', () => {
    for (const type of ['int8', 'int64', 'uint32', 'float32', 'float64', 'decimal'] as const) {
      const operator = operatorForType(type);
      for (const wanted of ['lt', 'lte', 'gt', 'gte', 'between', 'in'] as const) {
        expect(operator).toContain(wanted);
      }
      expect(operator).not.toContain('contains');
    }
  });

  it('offers truthiness for bool and only equality for opaque types', () => {
    expect(operatorForType('bool')).toContain('isTrue');
    expect(operatorForType('json')).toEqual(['eq', 'neq', 'isNull', 'isNotNull']);
    expect(operatorForType('struct')).toEqual(['eq', 'neq', 'isNull', 'isNotNull']);
  });

  it('reports arity and a label for every operator it offers', () => {
    const every = new Set(
      (
        ['utf8', 'float64', 'timestamp', 'bool', 'time64', 'json'] as const
      ).flatMap((t) => [...operatorForType(t)]),
    );
    for (const op of every) {
      expect(['none', 'scalar', 'list', 'range', 'duration']).toContain(operatorArity(op));
      expect(operatorLabel(op).length).toBeGreaterThan(0);
    }
    expect(operatorArity('between')).toBe('range');
    expect(operatorArity('in')).toBe('list');
    expect(operatorArity('inLast')).toBe('duration');
    expect(operatorArity('isNull')).toBe('none');
  });
});

// -----------------------------------------------------------------------------

describe('validation', () => {
  it('accepts a well-formed nested query', () => {
    const ast: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'price', operator: 'gt', value: 10 }),
        {
          kind: 'group',
          operator: 'or',
          child: [
            condition({ column: 'name', operator: 'contains', value: 'widget' }),
            condition({ column: 'created', operator: 'inLast', value: 7, unit: 'day' }),
          ],
        },
      ],
    };
    expect(validateQuery(ast, SCHEMA)).toEqual([]);
  });

  it('reports an unknown column at its exact path', () => {
    const ast = addCondition(
      addCondition(emptyQuery(), [], condition({ column: 'price', operator: 'gt', value: 1 })),
      [],
      condition({ column: 'nope', operator: 'eq', value: 1 }),
    );
    const error = validateQuery(ast, SCHEMA);
    expect(error).toHaveLength(1);
    expect(error[0]!.code).toBe('unknown-column');
    expect(error[0]!.path).toEqual([1]);
    expect(error[0]!.column).toBe('nope');
  });

  it('reports an operator that the column type does not offer', () => {
    const ast = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'price', operator: 'contains', value: 'x' }),
    );
    const error = validateQuery(ast, SCHEMA);
    expect(error).toHaveLength(1);
    expect(error[0]!.code).toBe('operator-not-allowed');
    expect(error[0]!.operator).toBe('contains');
    expect(error[0]!.message).toContain('float64');
  });

  it('reports a value that cannot be coerced to the column type, with the operand index', () => {
    const ast = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'quantity', operator: 'in', operand: [1, 'two', '3'] }),
    );
    const error = validateQuery(ast, SCHEMA);
    expect(error).toHaveLength(1);
    expect(error[0]!.code).toBe('value-not-coercible');
    expect(error[0]!.operandIndex).toBe(1);
    expect(error[0]!.path).toEqual([0]);
  });

  it('accepts numeric strings but rejects unparseable dates', () => {
    const ok = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'price', operator: 'lte', value: '42.5' }),
    );
    expect(validateQuery(ok, SCHEMA)).toEqual([]);

    const bad = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'created', operator: 'before', value: 'not-a-date' }),
    );
    expect(validateQuery(bad, SCHEMA)[0]!.code).toBe('value-not-coercible');
  });

  it('reports an empty group at its own path and does not descend', () => {
    const ast: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'price', operator: 'gt', value: 1 }),
        { kind: 'group', operator: 'or', child: [] },
      ],
    };
    const error = validateQuery(ast, SCHEMA);
    expect(error).toHaveLength(1);
    expect(error[0]!.code).toBe('empty-group');
    expect(error[0]!.path).toEqual([1]);
  });

  it('reports a missing scalar value and a wrong operand count separately', () => {
    const ast: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'price', operator: 'gt' }),
        condition({ column: 'price', operator: 'between', operand: [1] }),
      ],
    };
    const error = validateQuery(ast, SCHEMA);
    expect(error.map((e) => e.code)).toEqual(['missing-value', 'wrong-operand-count']);
    expect(error.map((e) => e.path)).toEqual([[0], [1]]);
  });

  it('reports an invalid regex and an invalid duration unit', () => {
    const ast: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'name', operator: 'matches', value: '([a-z' }),
        condition({
          column: 'created',
          operator: 'inLast',
          value: 3,
          unit: 'fortnight' as never,
        }),
      ],
    };
    const error = validateQuery(ast, SCHEMA);
    expect(error.map((e) => e.code)).toEqual(['invalid-regex', 'invalid-unit']);
  });

  it('addresses errors deep inside a nested tree', () => {
    let ast = emptyQuery();
    ast = addNode(ast, [], { kind: 'group', operator: 'or', child: [] });
    ast = addNode(ast, [0], { kind: 'group', operator: 'and', child: [] });
    ast = addCondition(ast, [0, 0], condition({ column: 'ghost', operator: 'eq', value: 1 }));
    const error = validateQuery(ast, SCHEMA);
    expect(error).toHaveLength(1);
    expect(error[0]!.path).toEqual([0, 0, 0]);
  });
});

// -----------------------------------------------------------------------------

describe('toFilterModel / fromFilterModel', () => {
  const protocolAst: QueryGroup = {
    kind: 'group',
    operator: 'and',
    child: [
      condition({ column: 'price', operator: 'gte', value: 10 }),
      {
        kind: 'group',
        operator: 'or',
        child: [
          condition({ column: 'name', operator: 'contains', value: 'wid', caseSensitive: true }),
          condition({ column: 'quantity', operator: 'in', operand: [1, 2, 3] }),
          {
            kind: 'group',
            operator: 'not',
            child: [
              condition({ column: 'active', operator: 'isNull' }),
              condition({ column: 'price', operator: 'between', operand: [1, 5] }),
            ],
          },
        ],
      },
    ],
  };

  it('emits the protocol vocabulary verbatim', () => {
    const model = toFilterModel(protocolAst);
    expect(model).toEqual({
      type: 'logical',
      op: 'and',
      filters: [
        { type: 'comparison', columnId: 'price', op: 'gte', value: 10 },
        {
          type: 'logical',
          op: 'or',
          filters: [
            {
              type: 'comparison',
              columnId: 'name',
              op: 'contains',
              value: 'wid',
              caseSensitive: true,
            },
            { type: 'comparison', columnId: 'quantity', op: 'in', values: [1, 2, 3] },
            {
              type: 'logical',
              op: 'not',
              filters: [
                { type: 'comparison', columnId: 'active', op: 'isNull' },
                { type: 'comparison', columnId: 'price', op: 'between', values: [1, 5] },
              ],
            },
          ],
        },
      ],
    });
  });

  it('round-trips losslessly over the protocol-expressible subset', () => {
    expect(isProtocolExpressible(protocolAst)).toBe(true);
    expect(fromFilterModel(toFilterModel(protocolAst))).toEqual(protocolAst);
  });

  it('round-trips an empty query through null', () => {
    expect(toFilterModel(emptyQuery())).toBeNull();
    expect(fromFilterModel(null)).toEqual(emptyQuery());
  });

  it('round-trips every protocol operator individually', () => {
    const sample: ReadonlyArray<Omit<QueryCondition, 'kind'>> = [
      { column: 'price', operator: 'eq', value: 1 },
      { column: 'price', operator: 'neq', value: 1 },
      { column: 'price', operator: 'lt', value: 1 },
      { column: 'price', operator: 'lte', value: 1 },
      { column: 'price', operator: 'gt', value: 1 },
      { column: 'price', operator: 'gte', value: 1 },
      { column: 'price', operator: 'in', operand: [1, 2] },
      { column: 'price', operator: 'notIn', operand: [1, 2] },
      { column: 'name', operator: 'contains', value: 'a' },
      { column: 'name', operator: 'notContains', value: 'a' },
      { column: 'name', operator: 'startsWith', value: 'a' },
      { column: 'name', operator: 'endsWith', value: 'a' },
      { column: 'name', operator: 'isNull' },
      { column: 'name', operator: 'isNotNull' },
      { column: 'price', operator: 'between', operand: [1, 2] },
      { column: 'price', operator: 'notBetween', operand: [1, 2] },
    ];
    for (const partial of sample) {
      const ast: QueryGroup = { kind: 'group', operator: 'and', child: [condition(partial)] };
      expect(fromFilterModel(toFilterModel(ast))).toEqual(ast);
    }
    expect(sample).toHaveLength(16);
  });

  it('lowers builder-only operators onto the protocol vocabulary', () => {
    const ast: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'created', operator: 'before', value: '2026-01-01T00:00:00.000Z' }),
        condition({ column: 'created', operator: 'after', value: '2026-01-01T00:00:00.000Z' }),
        condition({ column: 'active', operator: 'isTrue' }),
        condition({ column: 'created', operator: 'inLast', value: 1, unit: 'day' }),
      ],
    };
    const model = toFilterModel(ast, { now: NOW, schema: SCHEMA });
    expect(model).not.toBeNull();
    const filter = (model as LogicalFilter).filters as ReadonlyArray<ComparisonFilter>;
    expect(filter[0]!.op).toBe('lt');
    expect(filter[1]!.op).toBe('gt');
    expect(filter[2]).toEqual({ type: 'comparison', columnId: 'active', op: 'eq', value: true });
    expect(filter[3]!.op).toBe('between');
    expect(filter[3]!.values).toEqual([new Date('2026-09-03T12:00:00.000Z'), NOW]);
    expect(isProtocolExpressible(ast)).toBe(false);
  });

  it('throws a path-addressed compile error for matches', () => {
    const ast = addNode(
      addCondition(emptyQuery(), [], condition({ column: 'price', operator: 'gt', value: 1 })),
      [],
      { kind: 'group', operator: 'and', child: [condition({ column: 'name', operator: 'matches', value: '^a' })] },
    );
    try {
      toFilterModel(ast);
      throw new Error('expected toFilterModel to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(QueryCompileError);
      expect((e as QueryCompileError).path).toEqual([1, 0]);
    }
  });

  it('coerces raw operands against the schema when one is supplied', () => {
    const ast = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'quantity', operator: 'eq', value: '42' }),
    );
    expect(toFilterModel(ast, { schema: SCHEMA })).toEqual({
      type: 'logical',
      op: 'and',
      filters: [{ type: 'comparison', columnId: 'quantity', op: 'eq', value: 42 }],
    });
  });
});

// -----------------------------------------------------------------------------

describe('toSql', () => {
  const ast: QueryGroup = {
    kind: 'group',
    operator: 'and',
    child: [
      condition({ column: 'price', operator: 'gte', value: 10 }),
      {
        kind: 'group',
        operator: 'or',
        child: [
          condition({ column: 'name', operator: 'contains', value: 'wid' }),
          condition({ column: 'quantity', operator: 'in', operand: [1, 2] }),
        ],
      },
    ],
  };

  it('compiles postgres with numbered placeholders', () => {
    const sql = toSql(ast, 'postgres', { schema: SCHEMA });
    expect(sql.text).toBe(
      `"price" >= $1 AND (LOWER("name") LIKE $2 ESCAPE '!' OR "quantity" IN ($3, $4))`,
    );
    expect(sql.param).toEqual([10, '%wid%', 1, 2]);
  });

  it('compiles mysql with backtick identifiers and ? placeholders', () => {
    const sql = toSql(ast, 'mysql', { schema: SCHEMA });
    expect(sql.text).toBe(
      "`price` >= ? AND (LOWER(`name`) LIKE ? ESCAPE '!' OR `quantity` IN (?, ?))",
    );
    expect(sql.param).toEqual([10, '%wid%', 1, 2]);
  });

  it('compiles sqlite with ? placeholders and double-quoted identifiers', () => {
    const sql = toSql(ast, 'sqlite', { schema: SCHEMA });
    expect(sql.text).toContain('"price" >= ?');
    expect(sql.text).toContain('"quantity" IN (?, ?)');
    expect(sql.param).toEqual([10, '%wid%', 1, 2]);
  });

  it('compiles clickhouse with typed named placeholders and native string functions', () => {
    const sql = toSql(ast, 'clickhouse', { schema: SCHEMA });
    expect(sql.text).toBe(
      '"price" >= {p0:Float64} AND (position(lower("name"), {p1:String}) > 0 OR "quantity" IN ({p2:Int64}, {p3:Int64}))',
    );
    expect(sql.named).toEqual({ p0: 10, p1: 'wid', p2: 1, p3: 2 });
  });

  it('never lets a value reach the SQL text, including quotes and comment markers', () => {
    const hostile = "Rob'); DROP TABLE product; --";
    const evil: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'name', operator: 'eq', value: hostile }),
        condition({ column: 'name', operator: 'contains', value: hostile }),
        condition({ column: 'name', operator: 'in', operand: [hostile, 'x'] }),
        condition({ column: 'name', operator: 'matches', value: hostile }),
        condition({ column: 'name', operator: 'startsWith', value: hostile }),
      ],
    };
    for (const dialect of ['postgres', 'mysql', 'sqlite', 'clickhouse'] as const) {
      const sql = toSql(evil, dialect, { schema: SCHEMA });
      expect(sql.text).not.toContain('DROP TABLE');
      expect(sql.text).not.toContain('--');
      expect(sql.text).not.toContain('Rob');
      // The only apostrophe permitted in the text is the LIKE ESCAPE literal.
      expect(sql.text.replace(/ESCAPE '!'/g, '')).not.toContain("'");
      expect(sql.param.length).toBe(6);
      expect(sql.param.some((p) => String(p).includes('DROP TABLE'))).toBe(true);
    }
  });

  it('quotes identifiers per dialect, escaping the quote character itself', () => {
    const weird = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'we"ird`col', operator: 'isNull' }),
    );
    expect(toSql(weird, 'postgres').text).toBe('"we""ird`col" IS NULL');
    expect(toSql(weird, 'mysql').text).toBe('`we"ird``col` IS NULL');
  });

  it('qualifies with a table alias when asked', () => {
    const one = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'price', operator: 'lt', value: 5 }),
    );
    expect(toSql(one, 'postgres', { tableAlias: 't' }).text).toBe('"t"."price" < $1');
  });

  it('emits NOT around a negated group and constants for empty groups', () => {
    const negated: QueryGroup = {
      kind: 'group',
      operator: 'not',
      child: [condition({ column: 'active', operator: 'isTrue' })],
    };
    const sql = toSql(negated, 'postgres');
    expect(sql.text).toBe('NOT ("active" = $1)');
    expect(sql.param).toEqual([true]);

    expect(toSql(emptyQuery('and'), 'postgres').text).toBe('1 = 1');
    expect(toSql(emptyQuery('or'), 'postgres').text).toBe('1 = 0');
  });

  it('turns an empty IN list into a constant rather than invalid syntax', () => {
    const empty = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'quantity', operator: 'in', operand: [] }),
    );
    expect(toSql(empty, 'sqlite').text).toBe('1 = 0');
    const emptyNot = updateCondition(empty, [0], { operator: 'notIn' });
    expect(toSql(emptyNot, 'sqlite').text).toBe('1 = 1');
  });

  it('escapes LIKE metacharacters in the parameter, not the text', () => {
    const pct = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'name', operator: 'contains', value: '50%_off!' }),
    );
    const sql = toSql(pct, 'postgres');
    expect(sql.param[0]).toBe('%50!%!_off!!%');
    expect(sql.text).toBe('LOWER("name") LIKE $1 ESCAPE \'!\'');
  });

  it('honours caseSensitive and picks the right regex operator per dialect', () => {
    const sensitive = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'name', operator: 'startsWith', value: 'Ab', caseSensitive: true }),
    );
    expect(toSql(sensitive, 'postgres').text).toBe('"name" LIKE $1 ESCAPE \'!\'');
    expect(toSql(sensitive, 'postgres').param[0]).toBe('Ab%');

    const regex = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'name', operator: 'matches', value: '^a.*z$' }),
    );
    const expected: Record<SqlDialect, string> = {
      postgres: '"name" ~* $1',
      mysql: '`name` REGEXP ?',
      sqlite: '"name" REGEXP ?',
      clickhouse: 'match("name", {p0:String})',
    };
    for (const dialect of Object.keys(expected) as SqlDialect[]) {
      expect(toSql(regex, dialect).text).toBe(expected[dialect]);
    }
  });

  it('resolves a relative date range into two bound parameters', () => {
    const relative = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'created', operator: 'inLast', value: 2, unit: 'week' }),
    );
    const sql = toSql(relative, 'postgres', { now: NOW, schema: SCHEMA });
    expect(sql.text).toBe('"created" BETWEEN $1 AND $2');
    expect(sql.param).toEqual([new Date('2026-08-21T12:00:00.000Z'), NOW]);
  });

  it('emits NOT BETWEEN and NOT IN correctly', () => {
    const ranged: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'price', operator: 'notBetween', operand: [1, 2] }),
        condition({ column: 'quantity', operator: 'notIn', operand: [7] }),
      ],
    };
    const sql = toSql(ranged, 'sqlite');
    expect(sql.text).toBe('"price" NOT BETWEEN ? AND ? AND "quantity" NOT IN (?)');
  });
});

// -----------------------------------------------------------------------------

describe('toMongo', () => {
  it('compiles a nested query into $and / $or', () => {
    const ast: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'price', operator: 'gte', value: 10 }),
        {
          kind: 'group',
          operator: 'or',
          child: [
            condition({ column: 'quantity', operator: 'in', operand: [1, 2] }),
            condition({ column: 'active', operator: 'isFalse' }),
          ],
        },
      ],
    };
    expect(toMongo(ast, { schema: SCHEMA })).toEqual({
      $and: [
        { price: { $gte: 10 } },
        { $or: [{ quantity: { $in: [1, 2] } }, { active: { $eq: false } }] },
      ],
    });
  });

  it('expresses a NOT group as $nor over the conjunction', () => {
    const ast: QueryGroup = {
      kind: 'group',
      operator: 'not',
      child: [
        condition({ column: 'price', operator: 'gt', value: 1 }),
        condition({ column: 'price', operator: 'lt', value: 9 }),
      ],
    };
    expect(toMongo(ast)).toEqual({
      $nor: [{ $and: [{ price: { $gt: 1 } }, { price: { $lt: 9 } }] }],
    });
  });

  it('escapes regex metacharacters for substring operators', () => {
    const ast = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'name', operator: 'contains', value: 'a.b*c' }),
    );
    expect(toMongo(ast)).toEqual({ $and: [{ name: { $regex: 'a\\.b\\*c', $options: 'i' } }] });
  });

  it('passes a matches pattern through unescaped and honours caseSensitive', () => {
    const ast = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'name', operator: 'matches', value: '^a.*z$', caseSensitive: true }),
    );
    expect(toMongo(ast)).toEqual({ $and: [{ name: { $regex: '^a.*z$' } }] });
  });

  it('maps null checks, ranges and relative dates', () => {
    const ast: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'name', operator: 'isNull' }),
        condition({ column: 'name', operator: 'isNotNull' }),
        condition({ column: 'price', operator: 'between', operand: [1, 5] }),
        condition({ column: 'created', operator: 'inLast', value: 1, unit: 'hour' }),
      ],
    };
    expect(toMongo(ast, { now: NOW })).toEqual({
      $and: [
        { name: { $eq: null } },
        { name: { $ne: null } },
        { price: { $gte: 1, $lte: 5 } },
        { created: { $gte: new Date('2026-09-04T11:00:00.000Z'), $lte: NOW } },
      ],
    });
  });

  it('compiles an empty root to the match-everything document', () => {
    expect(toMongo(emptyQuery())).toEqual({});
    expect(toMongo(emptyQuery('or'))).toEqual({ $expr: false });
  });
});

// -----------------------------------------------------------------------------

describe('edit operations', () => {
  const base: QueryGroup = {
    kind: 'group',
    operator: 'and',
    child: [
      condition({ column: 'price', operator: 'gt', value: 1 }),
      {
        kind: 'group',
        operator: 'or',
        child: [
          condition({ column: 'name', operator: 'contains', value: 'a' }),
          condition({ column: 'name', operator: 'contains', value: 'b' }),
        ],
      },
    ],
  };

  it('addCondition appends without mutating and honours an explicit index', () => {
    const before = snapshot(base);
    const next = addCondition(
      base,
      [1],
      condition({ column: 'name', operator: 'endsWith', value: 'z' }),
      0,
    );
    expect(snapshot(base)).toBe(before);
    expect(next).not.toBe(base);
    expect(countCondition(next)).toBe(4);
    const inserted = nodeAt(next, [1, 0]);
    expect(inserted && isCondition(inserted) && inserted.operator).toBe('endsWith');
    // Untouched siblings keep their identity, which is what lets a UI memoise.
    expect(nodeAt(next, [0])).toBe(nodeAt(base, [0]));
  });

  it('removeNode deletes exactly one node without mutating, and refuses the root', () => {
    const before = snapshot(base);
    const next = removeNode(base, [1, 0]);
    expect(snapshot(base)).toBe(before);
    expect(countCondition(next)).toBe(2);
    expect(nodeAt(next, [1, 1])).toBeUndefined();
    expect(() => removeNode(base, [])).toThrow(RangeError);
  });

  it('updateCondition merges a patch and deletes keys set to undefined', () => {
    const before = snapshot(base);
    const next = updateCondition(base, [0], { operator: 'between', operand: [1, 5], value: undefined });
    expect(snapshot(base)).toBe(before);
    expect(nodeAt(next, [0])).toEqual(
      condition({ column: 'price', operator: 'between', operand: [1, 5] }),
    );
    expect(() => updateCondition(base, [1], { value: 1 })).toThrow(TypeError);
  });

  it('setGroupOperator swaps the operator without mutating', () => {
    const before = snapshot(base);
    const next = setGroupOperator(base, [1], 'not');
    expect(snapshot(base)).toBe(before);
    const group = nodeAt(next, [1]);
    expect(group && isGroup(group) && group.operator).toBe('not');
    // A no-op switch is genuinely a no-op — the node keeps its identity.
    expect(setGroupOperator(base, [1], 'or')).not.toBe(base);
    expect(nodeAt(setGroupOperator(base, [1], 'or'), [1])).toBe(nodeAt(base, [1]));
  });

  it('moveNode relocates a node across groups without mutating', () => {
    const before = snapshot(base);
    const next = moveNode(base, [0], [1], 0);
    expect(snapshot(base)).toBe(before);
    expect(countCondition(next)).toBe(3);
    expect(next.child).toHaveLength(1);
    const moved = nodeAt(next, [0, 0]);
    expect(moved && isCondition(moved) && moved.column).toBe('price');
  });

  it('moveNode rebases the destination index when moving within a group', () => {
    const flat: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'name', operator: 'eq', value: 'a' }),
        condition({ column: 'name', operator: 'eq', value: 'b' }),
        condition({ column: 'name', operator: 'eq', value: 'c' }),
      ],
    };
    const moved = moveNode(flat, [0], [], 2);
    expect(moved.child.map((c) => (isCondition(c) ? c.value : null))).toEqual(['b', 'a', 'c']);
    const back = moveNode(flat, [2], [], 0);
    expect(back.child.map((c) => (isCondition(c) ? c.value : null))).toEqual(['c', 'a', 'b']);
  });

  it('moveNode refuses to move a group into its own descendant', () => {
    expect(() => moveNode(base, [1], [1, 0])).toThrow(RangeError);
    expect(() => moveNode(base, [], [1])).toThrow(RangeError);
  });

  it('wrapInGroup brackets a node in place, including the root', () => {
    const before = snapshot(base);
    const next = wrapInGroup(base, [0], 'or');
    expect(snapshot(base)).toBe(before);
    const wrapper = nodeAt(next, [0]);
    expect(wrapper && isGroup(wrapper) && wrapper.operator).toBe('or');
    expect(nodeAt(next, [0, 0])).toBe(nodeAt(base, [0]));

    const rooted = wrapInGroup(base, [], 'not');
    expect(rooted.operator).toBe('not');
    expect(rooted.child[0]).toBe(base);
  });

  it('ungroup splices children into the parent and refuses the root', () => {
    const before = snapshot(base);
    const next = ungroup(base, [1]);
    expect(snapshot(base)).toBe(before);
    expect(next.child).toHaveLength(3);
    expect(countCondition(next)).toBe(3);
    expect(() => ungroup(base, [])).toThrow(RangeError);
    expect(() => ungroup(base, [0])).toThrow(TypeError);
  });

  it('survives deep nesting and addresses every level', () => {
    let ast = emptyQuery();
    const depth = 12;
    let path: NodePath = [];
    for (let i = 0; i < depth; i++) {
      ast = addNode(ast, path, { kind: 'group', operator: i % 2 === 0 ? 'and' : 'or', child: [] });
      path = [...path, 0];
    }
    ast = addCondition(ast, path, condition({ column: 'price', operator: 'gt', value: 1 }));
    expect(path).toHaveLength(depth);
    expect(countCondition(ast)).toBe(1);
    const leaf = nodeAt(ast, [...path, 0]);
    expect(leaf && isCondition(leaf)).toBe(true);
    expect(validateQuery(ast, SCHEMA)).toEqual([]);
    // And it still compiles all the way down.
    expect(toSql(ast, 'postgres').param).toEqual([1]);
    expect(fromFilterModel(toFilterModel(ast))).toEqual(ast);
  });

  it('rejects paths that run off the tree', () => {
    expect(() => addCondition(base, [9], condition({ column: 'price', operator: 'isNull' }))).toThrow(
      RangeError,
    );
    expect(() => removeNode(base, [1, 9])).toThrow(RangeError);
    expect(nodeAt(base, [0, 0])).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------

describe('describeQuery', () => {
  it('describes an empty query', () => {
    expect(describeQuery(emptyQuery(), SCHEMA)).toBe('Everything');
    expect(describeQuery(emptyQuery(), SCHEMA, { emptyText: 'No filter' })).toBe('No filter');
  });

  it('describes a nested query with display names and brackets', () => {
    const ast: QueryGroup = {
      kind: 'group',
      operator: 'and',
      child: [
        condition({ column: 'price', operator: 'gt', value: 100 }),
        {
          kind: 'group',
          operator: 'or',
          child: [
            condition({ column: 'name', operator: 'contains', value: 'ac' }),
            condition({ column: 'created', operator: 'inLast', value: 1, unit: 'day' }),
          ],
        },
      ],
    };
    expect(describeQuery(ast, SCHEMA)).toBe(
      'Price greater than 100 and (Name contains "ac" or Created in the last 1 day)',
    );
  });

  it('pluralises duration units and renders lists, ranges and NOT groups', () => {
    const ast: QueryGroup = {
      kind: 'group',
      operator: 'not',
      child: [
        condition({ column: 'quantity', operator: 'in', operand: [1, 2, 3] }),
        condition({ column: 'price', operator: 'between', operand: [1, 5] }),
        condition({ column: 'created', operator: 'inNext', value: 3, unit: 'week' }),
        condition({ column: 'active', operator: 'isNull' }),
      ],
    };
    expect(describeQuery(ast, SCHEMA)).toBe(
      'Not (Quantity is one of 1, 2, 3 and Price between 1 and 5 and Created in the next 3 weeks and Active is empty)',
    );
  });

  it('falls back to the column id when the schema has no display name', () => {
    const ast = addCondition(
      emptyQuery(),
      [],
      condition({ column: 'missing', operator: 'eq', value: 1 }),
    );
    expect(describeQuery(ast, SCHEMA)).toBe('Missing equals 1');
  });
});

// -----------------------------------------------------------------------------

describe('resolveDuration', () => {
  it('walks fixed units by milliseconds and calendar units by date arithmetic', () => {
    expect(resolveDuration('inLast', 3, 'day', NOW)[0].toISOString()).toBe(
      '2026-09-01T12:00:00.000Z',
    );
    expect(resolveDuration('inNext', 90, 'minute', NOW)[1].toISOString()).toBe(
      '2026-09-04T13:30:00.000Z',
    );
    expect(resolveDuration('inLast', 1, 'year', NOW)[0].getUTCFullYear()).toBe(2025);
    expect(resolveDuration('inLast', 2, 'quarter', NOW)[0].getUTCMonth()).toBe(2);
    const [lower, upper] = resolveDuration('inNext', 1, 'month', NOW);
    expect(lower).toEqual(NOW);
    expect(upper.getUTCMonth()).toBe(9);
  });
});
