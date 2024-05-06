import { Type, TypeKind } from "../Type";
import { TypeAttributeKind } from "./TypeAttributes";
import { assert } from "../support/Support";
import { messageError } from "../Messages";

// This can't be an object type, unfortunately, because it's in the
// type's identity and as such must be comparable and hashable with
// `areEqual`, `hashCodeOf`.
export type MinMaxConstraint = [number | undefined, number | undefined];

function checkMinMaxConstraint(minmax: MinMaxConstraint): MinMaxConstraint | undefined {
    const [min, max] = minmax;
    if (typeof min === "number" && typeof max === "number" && min > max) {
        return messageError("MiscInvalidMinMaxConstraint", { min, max });
    }
    if (min === undefined && max === undefined) {
        return undefined;
    }
    return minmax;
}

export class MinMaxConstraintTypeAttributeKind extends TypeAttributeKind<MinMaxConstraint> {
    constructor(
        name: string,
        private _typeKinds: Set<TypeKind>,
        private _minSchemaProperty: string,
        private _maxSchemaProperty: string
    ) {
        super(name);
    }

    get inIdentity(): boolean {
        return true;
    }

    combine(arr: MinMaxConstraint[]): MinMaxConstraint | undefined {
        assert(arr.length > 0);

        let [min, max] = arr[0];
        for (let i = 1; i < arr.length; i++) {
            const [otherMin, otherMax] = arr[i];
            if (typeof min === "number" && typeof otherMin === "number") {
                min = Math.min(min, otherMin);
            } else {
                min = undefined;
            }
            if (typeof max === "number" && typeof otherMax === "number") {
                max = Math.max(max, otherMax);
            } else {
                max = undefined;
            }
        }
        return checkMinMaxConstraint([min, max]);
    }

    intersect(arr: MinMaxConstraint[]): MinMaxConstraint | undefined {
        assert(arr.length > 0);

        let [min, max] = arr[0];
        for (let i = 1; i < arr.length; i++) {
            const [otherMin, otherMax] = arr[i];
            if (typeof min === "number" && typeof otherMin === "number") {
                min = Math.max(min, otherMin);
            } else if (min === undefined) {
                min = otherMin;
            }
            if (typeof max === "number" && typeof otherMax === "number") {
                max = Math.min(max, otherMax);
            } else if (max === undefined) {
                max = otherMax;
            }
        }
        return checkMinMaxConstraint([min, max]);
    }

    makeInferred(_: MinMaxConstraint): undefined {
        return undefined;
    }

    addToSchema(schema: { [name: string]: unknown }, t: Type, attr: MinMaxConstraint): void {
        if (this._typeKinds.has(t.kind)) return;

        const [min, max] = attr;
        if (min !== undefined) {
            schema[this._minSchemaProperty] = min;
        }
        if (max !== undefined) {
            schema[this._maxSchemaProperty] = max;
        }
    }

    stringify([min, max]: MinMaxConstraint): string {
        return `${min}-${max}`;
    }
}

export const minMaxTypeAttributeKind: TypeAttributeKind<MinMaxConstraint> = new MinMaxConstraintTypeAttributeKind(
    "minMax",
    new Set<TypeKind>(["integer", "double"]),
    "minimum",
    "maximum"
);

export const minMaxLengthTypeAttributeKind: TypeAttributeKind<MinMaxConstraint> = new MinMaxConstraintTypeAttributeKind(
    "minMaxLength",
    new Set<TypeKind>(["string"]),
    "minLength",
    "maxLength"
);

export function minMaxValueForType(t: Type): MinMaxConstraint | undefined {
    return minMaxTypeAttributeKind.tryGetInAttributes(t.getAttributes());
}

export function minMaxLengthForType(t: Type): MinMaxConstraint | undefined {
    return minMaxLengthTypeAttributeKind.tryGetInAttributes(t.getAttributes());
}

export class PatternTypeAttributeKind extends TypeAttributeKind<string> {
    constructor() {
        super("pattern");
    }

    get inIdentity(): boolean {
        return true;
    }

    combine(arr: string[]): string {
        assert(arr.length > 0);
        return arr.map(p => `(${p})`).join("|");
    }

    intersect(_arr: string[]): string | undefined {
        /** FIXME!!! what is the intersection of regexps? */
        return undefined;
    }

    makeInferred(_: string): undefined {
        return undefined;
    }

    addToSchema(schema: { [name: string]: unknown }, t: Type, attr: string): void {
        if (t.kind !== "string") return;
        schema.pattern = attr;
    }
}

export const patternTypeAttributeKind: TypeAttributeKind<string> = new PatternTypeAttributeKind();

export function patternForType(t: Type): string | undefined {
    return patternTypeAttributeKind.tryGetInAttributes(t.getAttributes());
}
