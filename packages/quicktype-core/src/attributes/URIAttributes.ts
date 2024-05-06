import { TypeAttributeKind } from "./TypeAttributes";
import { setUnionManyInto } from "collection-utils";
import { Type } from "../Type";

const protocolsSchemaProperty = "qt-uri-protocols";
const extensionsSchemaProperty = "qt-uri-extensions";

// protocols, extensions
type URIAttributes = [ReadonlySet<string>, ReadonlySet<string>];

class URITypeAttributeKind extends TypeAttributeKind<URIAttributes> {
    constructor() {
        super("uriAttributes");
    }

    get inIdentity(): boolean {
        return true;
    }

    combine(attrs: URIAttributes[]): URIAttributes {
        const protocolSets = attrs.map(a => a[0]);
        const extensionSets = attrs.map(a => a[1]);
        return [setUnionManyInto(new Set(), protocolSets), setUnionManyInto(new Set(), extensionSets)];
    }

    makeInferred(_: URIAttributes): undefined {
        return undefined;
    }

    addToSchema(schema: { [name: string]: unknown }, t: Type, attrs: URIAttributes): void {
        if (t.kind !== "string" && t.kind !== "uri") return;

        const [protocols, extensions] = attrs;
        if (protocols.size > 0) {
            schema[protocolsSchemaProperty] = Array.from(protocols).sort();
        }
        if (extensions.size > 0) {
            schema[extensionsSchemaProperty] = Array.from(extensions).sort();
        }
    }
}

export const uriTypeAttributeKind: TypeAttributeKind<URIAttributes> = new URITypeAttributeKind();
