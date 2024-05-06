import { iterableFind } from "collection-utils";

import { TargetLanguage } from "../TargetLanguage";
import { XSDLanguage } from './XSD';

export const all: TargetLanguage[] = [
    new XSDLanguage()
];

export function languageNamed(name: string, targetLanguages?: TargetLanguage[]): TargetLanguage | undefined {
    if (targetLanguages === undefined) {
        targetLanguages = all;
    }
    const maybeTargetLanguage = iterableFind(
        targetLanguages,
        l => l.names.indexOf(name) >= 0 || l.displayName === name
    );
    if (maybeTargetLanguage !== undefined) return maybeTargetLanguage;
    return iterableFind(targetLanguages, l => l.extension === name);
}
