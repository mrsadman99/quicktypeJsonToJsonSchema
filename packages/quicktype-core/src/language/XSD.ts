import { RenderContext, Renderer } from '../Renderer';
import '../ConvenienceRenderer';

import { Option } from 'RendererOptions';
import { TargetLanguage } from '../TargetLanguage';
import { StringTypeMapping, getNoStringTypeMapping } from '../TypeBuilder';
import { allUpperWordStyle, combineWords, firstUpperWordStyle, legalizeCharacters, splitIntoWords } from '../support/Strings';
import { Namer, Namespace, funPrefixNamer } from '../Naming';
import { ArrayType, ClassType, PrimitiveStringTypeKind, PrimitiveType, Type, isPrimitiveStringTypeKind } from '../Type';
import { defined } from '../support/Support';
import { convert, create as createSchema } from 'xmlbuilder2';
import { AttributesObject, XMLBuilder } from 'xmlbuilder2/lib/interfaces';
import { TypeRef } from '../TypeGraph';
import { iterableFind, mapFilter, mapFirst } from 'collection-utils';
import { matchTypeExhaustive } from '../TypeUtils';
// import { Readable } from 'readable-stream';
// import { Parser } from 'stream-json';

const legalizeName = legalizeCharacters(cp => cp >= 32 && cp < 128 && cp !== 0x2f /* slash */);

function XSDNameStyle(original: string): string {
    const words = splitIntoWords(original);
    return combineWords(
        words,
        legalizeName,
        firstUpperWordStyle,
        firstUpperWordStyle,
        allUpperWordStyle,
        allUpperWordStyle,
        "",
        _ => true
    );
}

const namingFunction = funPrefixNamer("namer", XSDNameStyle);

export class XSDLanguage extends TargetLanguage {
    constructor() {
        super("XSD", ["xsd"], "xsd");
    }

    protected getOptions(): Option<any>[] {
        return [];
    }

    get stringTypeMapping(): StringTypeMapping {
        return getNoStringTypeMapping();
    }

    protected makeRenderer(renderContext: RenderContext): Renderer {
        return new XSDRenderer(this, renderContext);
    }

    get supportsOptionalClassProperties(): boolean {
        return true;
    }
}

type renderType = (schema: XSDSchemaWrapper, key: string, additionalAttrs?: object, createElement?: boolean) => void;

class XSDSchemaWrapper {
    constructor(public inner: XMLBuilder, private baseSchemaPrefix: string) { }

    static supportedBaseTypes = ["string", "integer", "decimal", "dateTime", "date", "time", "boolean"];

    static typeAttributes = ["base", "type"];

    static mapPrimitiveStringToXSDTypes = new Map<PrimitiveStringTypeKind, string>([
        ["date", "dateType"],
        ["time", "timeType"],
        ["date-time", "dateTimeType"],
        ["uri", "uriType"],
        ["integer-string", "integerStringType"],
        ["bool-string", "booleanStringType"]
    ]);

    ele(name: any, attributes?: { [key: string]: any }): XSDSchemaWrapper {
        let processedAttrs = attributes;

        XSDSchemaWrapper.typeAttributes.forEach(typeAttr => {
            if (!processedAttrs?.hasOwnProperty(typeAttr)) {
                return;
            }
            const { [typeAttr]: typeValue } = processedAttrs;
            if (XSDSchemaWrapper.supportedBaseTypes.includes(typeValue)) {
                processedAttrs[typeAttr] = `${this.baseSchemaPrefix}:${typeValue}`
            }
        })
        const innerSchema = this.inner.ele(`${this.baseSchemaPrefix}:${name}`, processedAttrs);

        return new XSDSchemaWrapper(innerSchema, this.baseSchemaPrefix);
    }
}

export class XSDRenderer extends Renderer {
    private rootSchema: XSDSchemaWrapper
    private processedComplexTypes: Map<TypeRef, string> = new Map();
    private typeRefsByElementName: Map<string, { typeRef: TypeRef, elementPrefix: string }[]> = - new Map();

    constructor(targetLanguage: TargetLanguage, renderContext: RenderContext) {
        super(targetLanguage, renderContext);

        this.rootSchema = this.prepareSchema();
    }

    private get xmlnsPrefix(): string {
        return "xsd";
    }

    protected prepareSchema() {
        const innerSchema = createSchema()
            .ele(`${this.xmlnsPrefix}:schema`, { [`xmlns:${this.xmlnsPrefix}`]: "http://www.w3.org/2001/XMLSchema" })
        const xsdSchema = new XSDSchemaWrapper(innerSchema, this.xmlnsPrefix);

        this.renderBasicTypes(xsdSchema);

        return xsdSchema;
    }

    protected renderBasicTypes(xsdSchema: XSDSchemaWrapper) {
        this.renderDateType(xsdSchema);
        this.renderTimeType(xsdSchema);
        this.renderBooleanStringType(xsdSchema);
        this.renderIntegerStringType(xsdSchema);
        this.renderUriType(xsdSchema);
        this.renderNullType(xsdSchema);
    }

    protected renderDateType(xsdSchema: XSDSchemaWrapper) {
        const dateMatchPattern = "(0?[1-9]|[12][0-9]|3[01])[/.](0?[1-9]|1[0-2])[/.]\\d{4}";
        const unionScheme = xsdSchema
            .ele("simpleType", { name: "dateType" })
            .ele("union");
        unionScheme.ele("simpleType")
            .ele("restriction", { base: "date" })
        unionScheme.ele("simpleType")
            .ele("restriction", { base: "string" })
            .ele("pattern", { value: dateMatchPattern })
    }

    protected renderTimeType(xsdSchema: XSDSchemaWrapper) {
        const timeMatchPatterns = [
            "([0-1]?[0-9]|2[0-3]):([0-5][0-9])",
            "(0?[0-9]|1[01]):([0-5][0-9]) (AM|PM|a\\.m\\.|p\\.m\\.)"
        ];
        const unionScheme = xsdSchema.ele("simpleType", { name: "timeType" })
            .ele("union");
        unionScheme.ele("simpleType")
            .ele("restriction", { base: "time" });

        timeMatchPatterns.forEach(timeMatchPattern => {
            unionScheme.ele("simpleType")
                .ele("restriction", { base: "string" })
                .ele("pattern", { value: timeMatchPattern });
        })
    }

    protected renderIntegerStringType(xsdSchema: XSDSchemaWrapper) {
        xsdSchema.ele("simpleType", { name: XSDSchemaWrapper.mapPrimitiveStringToXSDTypes.get("integer-string") })
            .ele("restriction", { base: "string" })
            .ele("pattern", { value: "(0|-?[1-9]*)" });
    }

    protected renderBooleanStringType(xsdSchema: XSDSchemaWrapper) {
        xsdSchema.ele("simpleType", { name: XSDSchemaWrapper.mapPrimitiveStringToXSDTypes.get("bool-string") })
            .ele("restriction", { base: "string" })
            .ele("pattern", { value: "true|false" });
    }

    protected renderUriType(xsdSchema: XSDSchemaWrapper) {
        xsdSchema.ele("simpleType", { name: XSDSchemaWrapper.mapPrimitiveStringToXSDTypes.get("uri") })
            .ele("restriction", { base: "string" })
            .ele("pattern", { value: "(https?|ftp):\\/\\/[^{}]+\\.[^{}]+" });
    }

    protected renderNullType(xsdSchema: XSDSchemaWrapper) {
        xsdSchema.ele("simpleType", { name: "nullType" })
            .ele("restriction", { base: "string" })
            .ele("length", { value: "0" });
    }

    protected setUpNaming(): Iterable<Namespace> {
        return [];
    }

    protected makeNamedTypeNamer(): Namer {
        return namingFunction;
    }

    protected namerForObjectProperty(): null {
        return null;
    }

    protected makeUnionMemberNamer(): null {
        return null;
    }

    protected makeEnumCaseNamer(): null {
        return null;
    }

    private renderNull = (schema: XSDSchemaWrapper, key: string, additionalAttrs: object = {}): void => {
        schema.ele('element', { ...additionalAttrs, name: key, type: "nullType" });
    }

    private renderBool = (schema: XSDSchemaWrapper, key: string, additionalAttrs: object = {}): void => {
        schema.ele('element', { ...additionalAttrs, name: key, type: 'boolean' });
    }

    private renderInteger = (schema: XSDSchemaWrapper, key: string, additionalAttrs: object = {}): void => {
        schema.ele('element', { ...additionalAttrs, name: key, type: 'integer' });
    }

    private renderDouble = (schema: XSDSchemaWrapper, key: string, additionalAttrs: object = {}): void => {
        schema.ele('element', { ...additionalAttrs, name: key, type: 'decimal' });
    }

    private renderString = (schema: XSDSchemaWrapper, key: string, additionalAttrs: object = {}): void => {
        schema.ele('element', { ...additionalAttrs, name: key, type: 'string' });
    }

    private renderTransformedString = (
        type: PrimitiveType,
        schema: XSDSchemaWrapper,
        key: string,
        additionalAttrs: object = {}
    ): void => {
        const kind = type.kind;
        if (!isPrimitiveStringTypeKind(kind)) {
            return;
        }
        const xsdType = defined(XSDSchemaWrapper.mapPrimitiveStringToXSDTypes.get(kind));

        schema.ele('element', { ...additionalAttrs, name: key, type: xsdType });
    }

    private findSameTypeTagsCount(currentTypeRef: TypeRef, typeTag: string): number {
        return mapFilter(this.processedComplexTypes, (processedTypeTag, processedTypeRef) => {
            if (processedTypeRef === currentTypeRef) {
                return false;
            }
            const typeIndex = processedTypeTag.indexOf(typeTag);

            return typeIndex === 0 && !isNaN(+processedTypeTag.slice(typeTag.length));
        }).size;
    }

    private renderArray = (
        type: ArrayType,
        prefix: string,
        schema: XSDSchemaWrapper,
        key: string,
        additionalAttrs: object = {},
        createElement = true
    ): void => {
        const arrayElement = `${key}Array`;
        let arrayType = `${arrayElement}Type`;
        const processedType = this.processedComplexTypes.get(type.typeRef);
        const elementTypes = this.typeRefsByElementName.get(arrayElement) ?? [];

        const createElementCondition = createElement && ((processedType && !elementTypes.includes(type.typeRef)) || !processedType);

        if (createElementCondition) {
            elementTypes.push(type.typeRef);
            this.typeRefsByElementName.set(arrayElement, elementTypes);
        }

        // Add prefix to type when type with same name was processed
        if (!processedType && Array.from(this.processedComplexTypes.values()).includes(arrayType)) {
            arrayType = `${prefix}${arrayType.charAt(0).toUpperCase() + arrayType.slice(1)}`;
        }

        // process inner element of type
        if (schema !== this.rootSchema) {
            schema.ele("element", {
                ...additionalAttrs,
                name: key,
                type: processedType ?? arrayType
            });
        }

        if (!processedType) {
            this.processedComplexTypes.set(type.typeRef, arrayType);

            const complexTypeSchema = this.rootSchema.ele("complexType", { name: arrayType }).ele("sequence");

            this.renderType(type.items, complexTypeSchema, `${key}Item`, { maxOccurs: "unbounded", minOccurs: "0" }, false);
        }
    }

    private renderClass = (
        type: ClassType,
        prefix: string,
        schema: XSDSchemaWrapper,
        key: string,
        additionalAttrs: object = {},
        createElement = true
    ): void => {
        let classType = `${key}Type`;
        const newPrefix = `${prefix}${key.charAt(0).toUpperCase() + key.slice(1)}`;
        const processedType = this.processedComplexTypes.get(type.typeRef);
        const elementTypes = this.typeRefsByElementName.get(key) ?? [];

        const createElementCondition = createElement &&
            (processedType && !elementTypes.find(({ typeRef }) => typeRef === type.typeRef) || !processedType);

        if (createElementCondition) {
            elementTypes.push({ typeRef: type.typeRef, elementPrefix: prefix });
            this.typeRefsByElementName.set(key, elementTypes);
        }

        // Add prefix to type when type with same name was processed
        if (!processedType && Array.from(this.processedComplexTypes.values()).includes(classType)) {
            classType = `${newPrefix}Type`;
        }

        // process inner element of type
        if (schema !== this.rootSchema) {
            schema.ele("element", {
                ...additionalAttrs,
                name: key,
                type: processedType ?? classType
            });
        }

        if (!processedType) {
            this.processedComplexTypes.set(type.typeRef, classType);

            const complexTypeSchema = this.rootSchema
                .ele("complexType", { name: classType })
                .ele("all");

            type.getProperties().forEach((innerProp, innerKey) => {
                let derivedElementAttrs = {};
                if (innerProp.isOptional) {
                    derivedElementAttrs = { ...derivedElementAttrs, "minOccurs": 0 };
                }
                this.renderType(innerProp.type, complexTypeSchema, innerKey, newPrefix, derivedElementAttrs);
            });
        }
    }

    private renderType(
        t: Type,
        schema: XSDSchemaWrapper,
        key: string,
        prefix: string,
        additionalAttrs: object = {},
        createElement: boolean = true
    ): void {
        const renderCb = matchTypeExhaustive<renderType | null>(
            t,
            _noneType => null,
            _anyType => null,
            _nullType => this.renderNull,
            _boolType => this.renderBool,
            _integerType => this.renderInteger,
            _doubleType => this.renderDouble,
            _stringType => this.renderString,
            arrayType => this.renderArray.bind(this, arrayType, prefix),
            classType => this.renderClass.bind(this, classType, prefix),
            _mapType => null,
            _objectType => null,
            _enumType => null,
            _unionType => null,
            transformedStringType => this.renderTransformedString.bind(this, transformedStringType)
        );

        return renderCb?.(schema, key, additionalAttrs, createElement);
    }

    private renderElements() {
        this.typeRefsByElementName.forEach((typeRefs, elementName) => {
            this.rootSchema.ele(elementName,)
            this.processedComplexTypes.get(ty)
        })
    }

    protected emitSource(): void {
        if (this.topLevels.size !== 1) {
            throw Error('Not implemented multiple top levels');
        }

        this.renderType(defined(mapFirst(this.topLevels)), this.rootSchema, "root");

        convert
        const res = this.rootSchema.inner.end();
        console.log(res);
    }
}

// class XSDTypes {
//     constructor(private xsdObject: XMLSerializedAsObject) { }

//     elements: Map<string, object> = new Map();
//     simpleTypes: Map<string, object> = new Map();
//     complexTypes: Map<string, object> = new Map();

//     private fetchTypesFromObject() {
//         const xsdArrayOfObjects = this.xsdObject['#'] as object[];

//     }
// }

// export class XMLfromJSONStream {
//     private xsdSchema: XMLBuilder;
//     constructor(private readStream: Readable, private xsdObject: object, rootTag: string, xsdFile: string) {
//         this.xsdSchema = createSchema().ele(rootTag, {
//             'xmlns:xsd': "http://www.w3.org/2001/XMLSchema-instance",
//             'xsd:noNamespaceSchemaLocation': xsdFile
//         });
//     }

//     static methodMap: { [name: string]: string } = {
//         startObject: "pushObjectContext",
//         endObject: "finishObject",
//         startArray: "pushArrayContext",
//         endArray: "finishArray",
//         startNumber: "handleStartNumber",
//         numberChunk: "handleNumberChunk",
//         endNumber: "handleEndNumber",
//         keyValue: "setPropertyKey",
//         stringValue: "commitString",
//         nullValue: "commitNull",
//         trueValue: "handleBooleanValue",
//         falseValue: "handleBooleanValue"
//     };

//     async parse(readStream: Readable): Promise<Value> {
//         const combo = new Parser({ packKeys: true, packStrings: true });
//         combo.on("data", (item: { name: string; value: string | undefined }) => {
//             if (typeof XMLfromJSONStream.methodMap[item.name] === "string") {
//                 (this as any)[XMLfromJSONStream.methodMap[item.name]](item.value);
//             }
//         });
//         const promise = new Promise<Value>((resolve, reject) => {
//             combo.on("end", () => {
//                 resolve(this.finish());
//             });
//             combo.on("error", (err: any) => {
//                 reject(err);
//             });
//         });
//         readStream.setEncoding("utf8");
//         readStream.pipe(combo);
//         readStream.resume();
//         return promise;
//     }

//     protected handleStartNumber = (): void => {
//         this.pushContext();
//         this.context.currentNumberIsDouble = false;
//     };

//     protected handleNumberChunk = (s: string): void => {
//         const ctx = this.context;
//         if (!ctx.currentNumberIsDouble && /[\.e]/i.test(s)) {
//             ctx.currentNumberIsDouble = true;
//         }
//     };

//     protected handleEndNumber(): void {
//         const isDouble = this.context.currentNumberIsDouble;
//         this.popContext();
//         this.commitNumber(isDouble);
//     }

//     protected handleBooleanValue(): void {
//         this.commitBoolean();
//     }
// }
