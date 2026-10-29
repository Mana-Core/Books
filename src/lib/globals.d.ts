/* SPDX-License-Identifier: GPL-3.0-or-later */

// The host loads moment before every source (moment.js in the app's runtime scripts), so
// sources use that global rather than bundling their own copy. Type-only import: nothing
// from the package ends up in a bundle.
import type momentType from "moment";

declare global {
    const moment: typeof momentType;
}

export {};
