// =============================================================================
// Statistical-category aliases. Loaded by the `excel-compat/statistical`
// sub-path entry, after `stats` + `stats_extras` have registered the
// canonical dotted names (MODE.SNGL, STDEV.S, …).
// =============================================================================

import { getFunction, register } from './_shared';

register('MODE', getFunction('MODE.SNGL')!);
register('STDEV', getFunction('STDEV.S')!);
register('STDEVP', getFunction('STDEV.P')!);
register('VAR', getFunction('VAR.S')!);
register('VARP', getFunction('VAR.P')!);
register('RANK', getFunction('RANK.EQ')!);
register('PERCENTILE', getFunction('PERCENTILE.INC')!);
register('QUARTILE', getFunction('QUARTILE.INC')!);
register('PEARSON', getFunction('CORREL')!);
register('COVAR', getFunction('COVARIANCE.P')!);
