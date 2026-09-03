// =============================================================================
// Base cross-category aliases. Must load AFTER the base category modules so
// `getFunction(<name>)` resolves the canonical implementation.
//
// Only aliases whose TARGET is in the always-bundled base set live here.
// Aliases that point at a v1.1 function (UNICHAR→CHAR, MODE→MODE.SNGL, …)
// live next to the sub-path entry that registers their target — otherwise
// the alias would resolve `undefined` for an adopter who never opted in.
// =============================================================================

import { getFunction, register } from './_shared';

// Math
register('AVG', getFunction('AVERAGE')!);

// Text
register('CONCATENATE', getFunction('CONCAT')!);
