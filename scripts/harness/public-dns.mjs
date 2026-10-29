// SPDX-License-Identifier: GPL-3.0-or-later
//
// Opt-in preload that resolves hostnames through 1.1.1.1, for networks whose resolver
// answers some source domains with a block page (e.g. Telekom's CUII list):
//
//   node --import ./scripts/harness/public-dns.mjs scripts/verify.mjs <Name>
//
// Falls back to the system resolver when 1.1.1.1 has no answer.

import dns from "node:dns";

const resolver = new dns.Resolver();
resolver.setServers(["1.1.1.1", "1.0.0.1"]);
const systemLookup = dns.lookup;

dns.lookup = function lookup(hostname, options, callback) {
    if (typeof options === "function") {
        callback = options;
        options = {};
    }
    if (typeof options === "number") options = { family: options };
    resolver.resolve4(hostname, (error, addresses) => {
        if (error || !addresses.length) return systemLookup.call(dns, hostname, options, callback);
        if (options?.all) {
            return callback(
                null,
                addresses.map((address) => ({ address, family: 4 })),
            );
        }
        callback(null, addresses[0], 4);
    });
};
