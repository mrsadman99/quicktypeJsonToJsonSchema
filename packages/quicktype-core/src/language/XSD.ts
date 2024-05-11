import { RenderContext, Renderer } from '../Renderer';
import '../ConvenienceRenderer';

import { Option } from 'RendererOptions';
import { TargetLanguage } from '../TargetLanguage';
import { StringTypeMapping, getNoStringTypeMapping } from '../TypeBuilder';
import { Namespace } from '../Naming';
import { ArrayType, ClassType, PrimitiveType, PrimitiveTypeKind, Type, TypeKind, isPrimitiveStringTypeKind } from '../Type';
import { defined, nonNull, panic } from '../support/Support';
import { convert, create as createSchema } from 'xmlbuilder2';
import { XMLBuilder, XMLSerializedAsObject } from 'xmlbuilder2/lib/interfaces';
import { TypeRef } from '../TypeGraph';
import { arrayLast, iterableFirst, mapMap } from 'collection-utils';
import { matchTypeExhaustive } from '../TypeUtils';
import { readFile, writeFile } from 'fs';
// import { Readable } from 'readable-stream';
// import { Parser } from 'stream-json';

const XMLNS_PREFIX = 'xsd';
const addXmlnsPrefix = (name: string): XSDBaseType<string> => `${XMLNS_PREFIX}:${name}`;

type XSDBaseType<T extends string> = `${typeof XMLNS_PREFIX}:${T}`
type XMLObjectType = { [key: string]: any };
type TagDataType = { '@name': string } & XMLObjectType;
type XSDClassElementType = {
    '@type': string,
    '@minOccurs'?: '0'
} & TagDataType;
type XSDArrayElementType = {
    '@maxOccurs': 'unbounded',
    '@minOccurs': '0',
} & XSDClassElementType;

type XSDComplexClassType = {
    [innerObjectStructure in XSDBaseType<'all'>]: {
        [innerElements in XSDBaseType<'element'>]: XSDClassElementType[] | XSDClassElementType
    }
}
type XSDComplexArrayType = {
    [key in XSDBaseType<'sequence'>]: {
        [key in XSDBaseType<'element'>]: XSDArrayElementType
    }
}

const mapPrimitiveKindToXSDTypes: ReadonlyMap<PrimitiveTypeKind, string> = new Map([
    ["date", "dateType"],
    ["time", "timeType"],
    ["date-time", "dateTimeType"],
    ["uri", "uriType"],
    ["integer-string", "integerStringType"],
    ["bool-string", "booleanStringType"],
    ["string", addXmlnsPrefix('string')],
    ["integer", addXmlnsPrefix('integer')],
    ["double", addXmlnsPrefix('decimal')],
    ["bool", addXmlnsPrefix('boolean')],
    ["null", "nullType"]
]);
const mapXSDTypesToPrimitiveKind = new Map([...mapPrimitiveKindToXSDTypes.entries()]
    .map(([kind, xsdType]) => [xsdType, kind]));

export class XSDLanguage extends TargetLanguage {
    constructor() {
        super("XSD", ["xsd"], "xsd");
    }

    protected get defaultIndentation(): string {
        return "  ";
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
    constructor(public inner: XMLBuilder) { }

    private static supportedBaseTypes = ["string", "integer", "decimal", "dateTime", "date", "time", "boolean"];

    private static typeAttributes = ["base", "type"];

    ele(name: any, attributes?: { [key: string]: any }): XSDSchemaWrapper {
        let processedAttrs = attributes;

        XSDSchemaWrapper.typeAttributes.forEach(typeAttr => {
            if (!processedAttrs?.hasOwnProperty(typeAttr)) {
                return;
            }
            const { [typeAttr]: typeValue } = processedAttrs;
            if (XSDSchemaWrapper.supportedBaseTypes.includes(typeValue)) {
                processedAttrs[typeAttr] = addXmlnsPrefix(typeValue);
            }
        });
        const innerSchema = this.inner.ele(addXmlnsPrefix(name), processedAttrs);

        return new XSDSchemaWrapper(innerSchema);
    }
}

class XMLFormatConverterHandler {

    private toContentXMLString(xmlString: string): string {
        return xmlString.split('/n').map((xmlLine) => {
            let dataIndex = 0;
            while (xmlLine[dataIndex] === ' ' && xmlLine.length > dataIndex) {
                dataIndex++;
            }
            return xmlLine.slice(dataIndex)
        }).join('');
    }

    toXMLObjectFromString(xmlString: string) {
        const xmlContentString = this.toContentXMLString(xmlString);

        return convert(xmlContentString, { format: 'object' }) as XMLSerializedAsObject;
    }

    toXMLObjectFromFile(fileName: string): Promise<XMLSerializedAsObject> {
        return new Promise<XMLSerializedAsObject>(resolve => {
            readFile(fileName, (err, xmlBuffer) => {
                if (err) {
                    return panic(`Failed to read XML structure from ${fileName}, error: ${err}`)
                }

                resolve(this.toXMLObjectFromString(xmlBuffer.toString()));
            });
        })
    }

    toXMLFile(fileName: string, xmlString: string) {
        writeFile(fileName, xmlString, (err) => {
            if (err) {
                return panic(`Failed to write XML structure into ${fileName}, error: ${err}`)
            }
        });
    }

    parseJSONtoXML(jsonObject: object, xsdTypes: XSDTypes) {

    }
}

export class XSDRenderer extends Renderer {
    private rootSchema: XSDSchemaWrapper
    private processedComplexTypes: Map<TypeRef, string> = new Map();
    private typeRefsByElementName: Map<string, { typeRef: TypeRef, elementPrefixes: string[] }[]> = new Map();
    private xmlFormatConverter = new XMLFormatConverterHandler();

    constructor(targetLanguage: TargetLanguage, renderContext: RenderContext) {
        super(targetLanguage, renderContext);

        this.rootSchema = this.prepareSchema();
    }

    protected setUpNaming(): Iterable<Namespace> {
        return [];
    }

    protected prepareSchema() {
        const innerSchema = createSchema()
            .ele(addXmlnsPrefix('schema'), { [`xmlns:${XMLNS_PREFIX}`]: "http://www.w3.org/2001/XMLSchema" })
        const xsdSchema = new XSDSchemaWrapper(innerSchema);

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
            .ele("simpleType", { name: mapPrimitiveKindToXSDTypes.get("date") })
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
        const unionScheme = xsdSchema
            .ele("simpleType", { name: mapPrimitiveKindToXSDTypes.get("time") })
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
        xsdSchema.ele("simpleType", { name: mapPrimitiveKindToXSDTypes.get("integer-string") })
            .ele("restriction", { base: "string" })
            .ele("pattern", { value: "(0|-?[1-9]*)" });
    }

    protected renderBooleanStringType(xsdSchema: XSDSchemaWrapper) {
        xsdSchema.ele("simpleType", { name: mapPrimitiveKindToXSDTypes.get("bool-string") })
            .ele("restriction", { base: "string" })
            .ele("pattern", { value: "true|false" });
    }

    protected renderUriType(xsdSchema: XSDSchemaWrapper) {
        xsdSchema.ele("simpleType", { name: mapPrimitiveKindToXSDTypes.get("uri") })
            .ele("restriction", { base: "string" })
            .ele("pattern", { value: "(https?|ftp):\\/\\/[^{}]+\\.[^{}]+" });
    }

    protected renderNullType(xsdSchema: XSDSchemaWrapper) {
        xsdSchema.ele("simpleType", { name: "nullType" })
            .ele("restriction", { base: "string" })
            .ele("length", { value: "0" });
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
        const xsdType = defined(mapPrimitiveKindToXSDTypes.get(kind));

        schema.ele('element', { ...additionalAttrs, name: key, type: xsdType });
    }

    private renderArray = (
        type: ArrayType,
        prefixes: string[],
        schema: XSDSchemaWrapper,
        key: string,
        additionalAttrs: object = {},
        createElement = true
    ): void => {
        const newArrayType = `complexType${this.processedComplexTypes.size + 1}`;
        const processedType = this.processedComplexTypes.get(type.typeRef);
        const elementTypes = this.typeRefsByElementName.get(key) ?? [];

        const createElementCondition = createElement &&
            ((processedType && !elementTypes.find(({ typeRef }) => type.typeRef === typeRef)) || !processedType);

        if (createElementCondition) {
            elementTypes.push({ typeRef: type.typeRef, elementPrefixes: prefixes });
            this.typeRefsByElementName.set(key, elementTypes);
        }

        // process inner element of type
        if (schema !== this.rootSchema) {
            schema.ele("element", {
                ...additionalAttrs,
                name: key,
                type: processedType ?? newArrayType
            });
        }

        if (!processedType) {
            const itemElement = `${key}Item`;
            this.processedComplexTypes.set(type.typeRef, newArrayType);

            const complexTypeSchema = this.rootSchema.ele("complexType", { name: newArrayType }).ele("sequence");

            this.renderTypes(type.items, complexTypeSchema, prefixes, itemElement, { maxOccurs: "unbounded", minOccurs: "0" }, false);
        }
    }

    private renderClass = (
        type: ClassType,
        prefixes: string[],
        schema: XSDSchemaWrapper,
        key: string,
        additionalAttrs: object = {},
        createElement = true
    ): void => {
        const newClassType = `complexType${this.processedComplexTypes.size + 1}`;
        const processedType = this.processedComplexTypes.get(type.typeRef);
        const elementTypes = this.typeRefsByElementName.get(key) ?? [];

        const createElementCondition = createElement &&
            (processedType && !elementTypes.find(({ typeRef }) => typeRef === type.typeRef) || !processedType);

        if (createElementCondition) {
            elementTypes.push({ typeRef: type.typeRef, elementPrefixes: prefixes });
            this.typeRefsByElementName.set(key, elementTypes);
        }

        // process inner element of type
        if (schema !== this.rootSchema) {
            schema.ele("element", {
                ...additionalAttrs,
                name: key,
                type: processedType ?? newClassType
            });
        }

        if (!processedType) {
            this.processedComplexTypes.set(type.typeRef, newClassType);
            const mappedOldPrefixes = prefixes.map(prefix => {
                return `${prefix}${key.charAt(0).toUpperCase() + key.slice(1)}`;
            });
            const newPrefixes = [key, ...mappedOldPrefixes];

            const complexTypeSchema = this.rootSchema
                .ele("complexType", { name: newClassType })
                .ele("all");

            type.getProperties().forEach((innerProp, innerKey) => {
                let derivedElementAttrs = {};
                if (innerProp.isOptional) {
                    derivedElementAttrs = { ...derivedElementAttrs, "minOccurs": 0 };
                }
                this.renderTypes(innerProp.type, complexTypeSchema, newPrefixes, innerKey, derivedElementAttrs);
            });
        }
    }

    private renderTypes(
        t: Type,
        schema: XSDSchemaWrapper,
        prefixes: string[],
        key: string,
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
            arrayType => this.renderArray.bind(this, arrayType, prefixes),
            classType => this.renderClass.bind(this, classType, prefixes),
            _mapType => null,
            _objectType => null,
            _enumType => null,
            _unionType => null,
            transformedStringType => this.renderTransformedString.bind(this, transformedStringType)
        );

        return renderCb?.(schema, key, additionalAttrs, createElement);
    }

    private renderElements() {
        this.typeRefsByElementName.forEach((elementData, elementKey) => {
            let success = true;
            let prefixIndex = -1;
            let typeRefsByNewElementKey: Map<string, TypeRef> = new Map();
            const renderSchemaElements = () => typeRefsByNewElementKey.forEach((typeRef, elementKey) => {
                this.rootSchema.ele("element", {
                    name: elementKey,
                    type: defined(this.processedComplexTypes.get(typeRef))
                })
            });

            if (elementData.length === 1) {
                typeRefsByNewElementKey.set(elementKey, defined(iterableFirst(elementData)).typeRef)
                renderSchemaElements();
                return;
            }

            do {
                typeRefsByNewElementKey = new Map();
                success = true;
                prefixIndex++;

                elementData.forEach(({ typeRef, elementPrefixes }) => {
                    const currentPrefix = elementPrefixes[prefixIndex] ?? arrayLast(elementPrefixes);
                    const newElementKey = currentPrefix ?
                        `${currentPrefix}${elementKey.charAt(0).toUpperCase() + elementKey.slice(1)}` :
                        elementKey;

                    if (typeRefsByNewElementKey.has(newElementKey)) {
                        success = false;
                        return;
                    }

                    typeRefsByNewElementKey.set(newElementKey, typeRef);
                });
            } while (!success);

            renderSchemaElements();
        });
    }

    protected async emitSource(givenOutputFilename: string, inputObjects: object[]): Promise<void> {
        if (this.topLevels.size !== 1 || inputObjects.length !== 1) {
            throw Error('Not implemented multiple top levels');
        }

        const [topLevelName, topLevelStructure] = defined(iterableFirst(this.topLevels));
        const inputObject = defined(iterableFirst(inputObjects));

        this.renderTypes(topLevelStructure, this.rootSchema, [], topLevelName);
        this.renderElements();
        const xsdString = this.rootSchema.inner.end({ prettyPrint: true });

        // // Makes xml file lines from input
        // new XSDTypes(this.xmlFormatConverter.toXMLObjectFromString(xsdString));
        // this.emitMultiline(xsdString, 2);
        // this.finishFile()

        // emit XSD file lines
        this.emitMultiline(xsdString, 2);
        new XSDTypes(this.xmlFormatConverter.toXMLObjectFromString(xsdString));
    }
}

class XSDTypes {
    constructor(private xsdObject: XMLSerializedAsObject) {
        this.fetchTypesFromObject();
        this.getTypesStructure();
    }

    private elements: Map<string, string> = new Map();
    private complexTypes: Map<string, XMLObjectType> = new Map();

    objectTypes: Map<string, Map<string, { isOptional: boolean, kind: TypeKind }>> = new Map();
    arrayTypes: Map<string, { kind: TypeKind, itemTag: string }> = new Map();

    private get objectInnerTag(): XSDBaseType<'all'> {
        return addXmlnsPrefix('all') as XSDBaseType<'all'>;
    }

    private get arrayInnerTag(): XSDBaseType<'sequence'> {
        return addXmlnsPrefix('sequence') as XSDBaseType<'sequence'>;
    }

    private get elementTag(): XSDBaseType<'element'> {
        return addXmlnsPrefix('element') as XSDBaseType<'element'>;
    }

    private isClassType(complexTypeInnerStructure: any): complexTypeInnerStructure is XSDComplexClassType {
        if (!(this.objectInnerTag in complexTypeInnerStructure) ||
            typeof complexTypeInnerStructure[this.objectInnerTag] !== 'object') {
            return false;
        }

        const objectInnerStructure = complexTypeInnerStructure[this.objectInnerTag]
        const objectElements = objectInnerStructure[this.elementTag]
        return typeof objectElements === 'object' || Array.isArray(objectElements);
    }

    private getClassTypeProperties(complexTypeInnerStructure: any): Map<string, { type: string, isOptional: boolean }> | null {
        if (!this.isClassType(complexTypeInnerStructure)) {
            return null;
        }
        let elements = complexTypeInnerStructure[this.objectInnerTag][this.elementTag];

        if (!Array.isArray(elements)) {
            elements = [elements];
        }

        return new Map(elements.map(element => [
            element['@name'],
            {
                type: element['@type'],
                isOptional: Number(element['@minOccurs']) === 0
            }
        ]));
    }

    private isArrayType(complexTypeInnerStructure: any): complexTypeInnerStructure is XSDComplexArrayType {
        if (!(this.arrayInnerTag in complexTypeInnerStructure)) {
            return false;
        }
        const arrayInnerStructure = complexTypeInnerStructure[this.arrayInnerTag];
        if (!(this.elementTag in arrayInnerStructure) || typeof arrayInnerStructure[this.elementTag] !== 'object') {
            return false;
        }

        const arrayItem = arrayInnerStructure[this.elementTag];

        return typeof arrayItem === 'object' && arrayItem['@maxOccurs'] === 'unbounded' && +arrayItem['@minOccurs'] === 0
    }

    getArrayTypeItem(complexTypeInnerStructure: any): { type: string, tag: string } | null {
        if (!this.isArrayType(complexTypeInnerStructure)) {
            return null;
        }
        const arrayElement = complexTypeInnerStructure['xsd:sequence']['xsd:element'];
        return { type: arrayElement['@type'], tag: arrayElement['@name'] };
    }

    private getTypeKind(xsdType: string, complexTypes: Map<string, XMLObjectType>): TypeKind {
        const primitiveKind = mapXSDTypesToPrimitiveKind.get(xsdType);
        if (primitiveKind) {
            return primitiveKind;
        }
        const complexTypeInnerStructure = complexTypes.get(xsdType);
        if (this.isArrayType(complexTypeInnerStructure)) {
            return "array";
        }

        if (this.isClassType(complexTypeInnerStructure)) {
            return "class";
        }

        return "none";
    }

    private getXSDObjectTypesStructure(elementType: string, elementTag: string) {
        const iterateDeep = (kind: TypeKind, type: string, tag: string) => {
            if (["class", "array"].includes(kind)) {
                this.getXSDObjectTypesStructure(type, tag);
            }
        }
        const complexTypeInnerStructure = defined(this.complexTypes.get(elementType));

        if (this.isArrayType(complexTypeInnerStructure)) {
            const arrayItem = nonNull(this.getArrayTypeItem(complexTypeInnerStructure));
            const arrayItemKind = this.getTypeKind(arrayItem.type, this.complexTypes);
            this.arrayTypes.set(elementTag, { kind: arrayItemKind, itemTag: arrayItem.tag });

            iterateDeep(arrayItemKind, arrayItem.type, `${elementTag}.${arrayItem.tag}`);
        } else if (this.isClassType(complexTypeInnerStructure)) {
            const classProperties = nonNull(this.getClassTypeProperties(complexTypeInnerStructure));

            const classPropertiesKind = mapMap(classProperties, ({ type, isOptional }) => {
                return { isOptional, kind: this.getTypeKind(type, this.complexTypes) };
            });
            this.objectTypes.set(elementTag, classPropertiesKind);

            classPropertiesKind.forEach(({ kind }, tag) =>
                iterateDeep(kind, defined(classProperties.get(tag)?.type), `${elementTag}.${tag}`)
            );
        }
    }

    public getTypesStructure() {
        this.elements.forEach((elementType, elementTag) =>
            this.getXSDObjectTypesStructure(elementType, elementTag)
        )
    }

    private fetchTypesFromObject() {
        const xsdArrayOfObjects = this.xsdObject[addXmlnsPrefix('schema')] as XMLSerializedAsObject;

        // this.simpleTypes = this.fetchTag(xsdArrayOfObjects, 'simpleType');
        this.complexTypes = this.fetchTag(xsdArrayOfObjects, 'complexType');

        this.elements = mapMap(this.fetchTag(xsdArrayOfObjects, 'element'), ((elementData) => {
            const { ['@type']: elementType } = elementData as { ['@type']: string } & XMLObjectType;
            return defined(elementType);
        }));
    }

    private fetchTag(xsdObjectTypes: XMLSerializedAsObject, tag: string): Map<string, XMLObjectType> {
        const fullTagName = addXmlnsPrefix(tag);
        const tagMap: Map<string, XMLObjectType> = new Map();
        const tagArray: TagDataType[] = [];

        // Process unordered tags in object
        if (xsdObjectTypes.hasOwnProperty('#')) {
            const objectData = xsdObjectTypes['#'];

            if (!Array.isArray(objectData)) {
                return tagMap;
            }

            objectData.forEach(tagData => {
                if (typeof tagData === 'object' && tagData.hasOwnProperty(fullTagName)) {
                    const followingTagData = tagData[fullTagName]

                    if (typeof followingTagData !== 'object') {
                        return tagMap;
                    }

                    if (Array.isArray(followingTagData)) {
                        tagArray.push(...followingTagData as TagDataType[])
                    } else {
                        tagArray.push(followingTagData as TagDataType);
                    }
                }
            })
        } else {
            const tagData = xsdObjectTypes[addXmlnsPrefix(tag)];
            tagArray.push(...(Array.isArray(tagData) ? tagData : [tagData]) as TagDataType[]);
        }

        tagArray.forEach(tagData => {
            const { ['@name']: tagName, ...restData } = tagData;
            tagMap.set(tagName, restData);
        })

        return tagMap;
    }
}

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
