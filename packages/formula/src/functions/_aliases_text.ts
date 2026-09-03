// =============================================================================
// Text-category aliases whose target is a v1.1 function. Loaded by the
// `excel-compat/text` sub-path entry, after `text_v11` has registered CHAR.
// =============================================================================

import { getFunction, register } from './_shared';

register('UNICHAR', getFunction('CHAR')!);
