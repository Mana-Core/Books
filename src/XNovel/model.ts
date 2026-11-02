/* SPDX-License-Identifier: GPL-3.0-or-later */

export const BASE_URL = "https://xnovel.me";
export const NOVEL_PATH = /^\/\d+-[^/]+$/;
export const CHAPTER_PATH = /^\/\d+-[^/]+\/\d+-[^/]+$/;

export const FILTER = {
    genre: "genre",
    status: "status",
} as const;

export const STATUS_PATHS = {
    ongoing: "/ongoing",
    completed: "/completed",
} as const;

export type StatusFilter = keyof typeof STATUS_PATHS;

export const HIDDEN_BOXES = [
    "[hidden]",
    '[style*="display:none"]',
    '[style*="display: none"]',
    '[style*="font-size:0"]',
];
