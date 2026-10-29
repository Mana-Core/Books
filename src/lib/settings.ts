/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    UIListSection,
    UIPicker,
    type FormSection,
    UITextField,
    UIToggle,
    type Option,
    type UIPickerDefinition,
    type UITextFieldDefinition,
    type UIToggleDefinition,
} from "@mana-app/types";

type Scalar = string | number | boolean | string[];

/**
 * Typed preferences over `ObjectStore`, which the host already scopes to the source.
 * A stored value of the wrong type falls back to the default rather than throwing, so a
 * renamed option never breaks a source for someone who set the old one.
 */
export class Preferences<T extends Record<string, Scalar>> {
    constructor(private readonly defaults: T) {}

    async get<K extends keyof T & string>(key: K): Promise<T[K]> {
        const fallback = this.defaults[key];
        const value = await ObjectStore.get(key);

        if (Array.isArray(fallback)) {
            const isStringList = Array.isArray(value) && value.every((v) => typeof v === "string");
            return (isStringList ? value : fallback) as T[K];
        }

        return (typeof value === typeof fallback ? value : fallback) as T[K];
    }

    async set<K extends keyof T & string>(key: K, value: T[K]): Promise<void> {
        await ObjectStore.set(key, value);
    }

    async toggle(key: KeysOf<T, boolean>, title: string): Promise<UIToggleDefinition> {
        const value = (await this.get(key)) as boolean;

        return UIToggle({
            id: key,
            title,
            value,
            didChange: (value) => this.set(key, value as T[typeof key]),
        });
    }

    async picker(
        key: KeysOf<T, string>,
        title: string,
        options: Option[],
    ): Promise<UIPickerDefinition> {
        const value = (await this.get(key)) as string;

        return UIPicker({
            id: key,
            title,
            options,
            value,
            didChange: (value) => this.set(key, value as T[typeof key]),
        });
    }
}

type KeysOf<T, V> = { [K in keyof T]: T[K] extends V ? K : never }[keyof T] & string;

/** The "Reading" section, for a source's options about what a chapter shows. */
export function readingSection(children: UIToggleDefinition[], footer?: string): FormSection {
    return UIListSection({ header: "Reading", footer, children });
}

/** Strings kept in the Keychain. An empty value removes the entry. */
export const Secrets = {
    async get(key: string): Promise<string | undefined> {
        const value = await SecureStore.get(key);

        return typeof value === "string" && value ? value : undefined;
    },

    async set(key: string, value: string | undefined): Promise<void> {
        if (value) {
            await SecureStore.set(key, value);
        } else {
            await SecureStore.remove(key);
        }
    },

    async field(key: string, title: string, placeholder?: string): Promise<UITextFieldDefinition> {
        const value = (await Secrets.get(key)) ?? "";

        return UITextField({
            id: key,
            title,
            placeholder,
            secure: true,
            value,
            didChange: (value) => Secrets.set(key, value.trim()),
        });
    },
};
