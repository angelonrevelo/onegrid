// =============================================================================
// @onegrid/formula/excel-compat
//
// Opt-in v1.1 function expansion. The default `@onegrid/formula` barrel stays
// on the always-bundled base set; importing this module registers the v1.1
// families (math/text/datetime/logical/info) plus aliases that point at them.
// =============================================================================

import './functions';
import './functions/math_v11';
import './functions/logical_v11';
import './functions/text_v11';
import './functions/datetime_v11';
import './functions/info_v11';
import './functions/_aliases_text';
import './functions/_aliases_stats';
