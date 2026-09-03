// =============================================================================
// Info category — the v1.0 base set: ISNUMBER/ISTEXT/ISBLANK/ISERROR.
// Always bundled. The v1.1 predicates live in `info_v11.ts`.
// =============================================================================

import { toNumber } from '../coerce';
import {
  DIV_ZERO,
  type FormulaError,
  NA_ERROR,
  NAME_ERROR,
  NUM_ERROR,
  VALUE_ERROR,
  isFormulaError,
} from '../errors';
import { register } from './_shared';

register('ISNUMBER', (args) => typeof args[0] === 'number');
register('ISTEXT', (args) => typeof args[0] === 'string');
register('ISBLANK', (args) => {
  // Excel-compat: only truly-empty cells are blank. Empty string `""` is
  // NOT blank (Excel distinguishes "blank cell" from "cell containing
  // empty string"; LEN("") = 0 but ISBLANK("") = FALSE).
  return args[0] === null || args[0] === undefined;
});
register('ISERROR', (args) => isFormulaError(args[0]));
