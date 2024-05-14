import { RenderContext, Renderer } from '../Renderer';
import '../ConvenienceRenderer';

import { Option } from '../RendererOptions';
import { TargetLanguage } from '../TargetLanguage';
import { StringTypeMapping, getNoStringTypeMapping } from '../TypeBuilder';
import { Namespace } from '../Naming';
import { ArrayType, ClassType, PrimitiveType, PrimitiveTypeKind, Type, TypeKind, UnionType, isPrimitiveStringTypeKind, isPrimitiveTypeKind } from '../Type';
import { defined, panic } from '../support/Support';
import { convert, create as createSchema } from 'xmlbuilder2';
import { XMLBuilder, XMLSerializedAsObject } from 'xmlbuilder2/lib/interfaces';
import { TypeRef } from '../TypeGraph';
import { arrayLast, iterableEvery, iterableFirst, mapMap } from 'collection-utils';
import { matchTypeExhaustive } from '../TypeUtils';
import { readFile } from 'fs';
import { DateTimeRecognizer } from '../DateTime';
import { isURI } from '../attributes/StringTypes';
// import { Readable } from 'readable-stream';
// import { Parser } from 'stream-json';

const XMLNS_PREFIX = 'xsd';
const BASE_XMLNS = "http://www.w3.org/2001/XMLSchema";

function addXmlnsPrefix<T extends string>(name: T): XSDBaseType<T> {
    return `${XMLNS_PREFIX}:${name}`;
}

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
type XSDUnionType = {
    [key in XSDBaseType<'union'>]: {
        [key in XSDBaseType<'simpleType'>]: {
            [key in XSDBaseType<'restriction'>]: { '@base': string }
        }[]
    }
}

type ArrayItem = { kind: TypeKind, itemTag: string, itemType: string };
type ClassProp = { isOptional: boolean, kind: TypeKind, type: string };

type ConvertFormatType = 'XML' | 'JSON';
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

export class XMLFormatConverterHandler {

    toXMLObjectFromString(xmlString: string) {
        return convert(xmlString, { format: 'object' }) as XMLSerializedAsObject;
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

    parseXMLtoJSON(xmlObject: object, xsdTypes: XSDTypes): object {
        let currentPath = '';
        const [omittedTopTag, xmlDataObject] = defined(iterableFirst(Object.entries(xmlObject)));
        const topDataKind = xsdTypes.getXMLObjectKind(xmlDataObject, omittedTopTag);

        const parseCurrentObject = (currentXMLObject: { [key: string]: any }, objectTag: string, kind: TypeKind | undefined): any => {
            currentPath = currentPath ? `${currentPath}.${objectTag}` : objectTag;
            let result: any = null;

            if (kind === 'union') {
                result = xsdTypes.parseUnion(currentXMLObject, currentPath, 'JSON');
            } else if (kind === 'array' && typeof currentXMLObject === 'object') {
                const arrayItemType = xsdTypes.getArrayType(currentPath);
                if (!arrayItemType || !Array.isArray(currentXMLObject[arrayItemType.itemTag])) {
                    panic(`Failed to parse array by path ${currentPath}`);
                }
                result = [];
                currentXMLObject[arrayItemType.itemTag].forEach((arrayItem: any) => {
                    result.push(parseCurrentObject(arrayItem, arrayItemType.itemTag, arrayItemType.kind));
                })
            } else if (kind === 'class' && typeof currentXMLObject === 'object') {
                const classProps = xsdTypes.getClassType(currentPath);

                if (!classProps || !xsdTypes.isValidClassPropsInXMLObject(currentXMLObject, currentPath)) {
                    panic(`Failed to parse class by path ${currentPath}`);
                }
                result = {};

                Object.entries(currentXMLObject).forEach(([propKey, propData]) => {
                    // Omit attributes in object data
                    if (propKey.startsWith('@') || !classProps.get(propKey)) {
                        return;
                    }
                    const propType = defined(classProps.get(propKey));

                    result[propKey] = parseCurrentObject(propData, propKey, propType.kind);
                });
            } else if (kind && isPrimitiveTypeKind(kind)) {
                result = xsdTypes.parsePrimitiveKind(currentXMLObject, kind, 'JSON');
            } else {
                panic(`Failed to parse ${currentPath} with value ${currentXMLObject} and type ${kind}`);
            }

            const endOfParentPath = currentPath.lastIndexOf('.');
            currentPath = currentPath.slice(0, endOfParentPath);

            return result;
        };

        return parseCurrentObject(xmlDataObject, omittedTopTag, topDataKind);
    }

    parseJSON(jsonObject: object, xsdTypes: XSDTypes, topLevelTag: string, xsdFileName: string): string {
        const topKind: TypeKind = Array.isArray(jsonObject) ? 'array' : 'class';
        let currentPath = '';
        const xmlBuilder = createSchema();

        const parseCurrentObject = (currentObject: object, objectTag: string, currentSchema: XMLBuilder, kind: TypeKind): XMLBuilder => {
            currentPath = currentPath ? `${currentPath}.${objectTag}` : objectTag;
            const innerSchema = currentSchema.ele(objectTag);

            if (kind === 'union') {
                innerSchema.txt(xsdTypes.parseUnion(currentObject, currentPath, 'XML')?.toString() ?? '');
            } else if (Array.isArray(currentObject) && kind === 'array') {
                const arrayItem = xsdTypes.getArrayType(currentPath);
                if (!arrayItem) {
                    panic(`Array with path ${currentPath} not found`);
                }

                currentObject.forEach((value) => {
                    parseCurrentObject(value, arrayItem.itemTag, innerSchema, arrayItem.kind);
                });
            } else if (typeof currentObject === 'object' && kind === 'class') {
                const objectStructure = xsdTypes.getClassType(currentPath);
                if (!objectStructure) {
                    panic(`Object with path ${currentPath} not found`);
                }

                Object.entries(currentObject).forEach(([propName, propValue]) => {
                    const propStructure = objectStructure.get(propName);
                    if (!propStructure) {
                        panic(`Failed to find ${propName} in ${currentPath} object structure`);
                    }
                    parseCurrentObject(propValue, propName, innerSchema, propStructure.kind);
                });
            } else if (isPrimitiveTypeKind(kind)) {
                innerSchema.txt(xsdTypes.parsePrimitiveKind(currentObject, kind, 'XML')?.toString() ?? '');
            } else {
                panic(`Failed to parse ${currentPath} with value ${currentObject} and type ${kind}`);
            }

            const endOfParentPath = currentPath.lastIndexOf('.');
            currentPath = currentPath.slice(0, endOfParentPath);

            return innerSchema;
        }

        const topLevelBuilder = parseCurrentObject(jsonObject, topLevelTag, xmlBuilder, topKind);
        topLevelBuilder
            .att(`xmlns:${XMLNS_PREFIX}`, `${BASE_XMLNS}-instance`)
            .att(addXmlnsPrefix('noNamespaceSchemaLocation'), xsdFileName);

        return xmlBuilder.end({ prettyPrint: true });
    }
}

export class XSDRenderer extends Renderer {
    private rootSchema: XSDSchemaWrapper
    private processedCustomTypes: Map<TypeRef, string> = new Map();
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
            .ele(addXmlnsPrefix('schema'), { [`xmlns:${XMLNS_PREFIX}`]: BASE_XMLNS })
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
        const newArrayType = `complexType${this.processedCustomTypes.size + 1}`;
        const processedType = this.processedCustomTypes.get(type.typeRef);
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
            this.processedCustomTypes.set(type.typeRef, newArrayType);

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
        const newClassType = `complexType${this.processedCustomTypes.size + 1}`;
        const processedType = this.processedCustomTypes.get(type.typeRef);
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
            this.processedCustomTypes.set(type.typeRef, newClassType);
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

    private renderUnion(
        type: UnionType,
        prefixes: string[],
        schema: XSDSchemaWrapper,
        key: string,
        additionalAttrs: object = {},
        createElement = true
    ) {
        const newUnionType = `complexType${this.processedCustomTypes.size + 1}`;
        const processedType = this.processedCustomTypes.get(type.typeRef);
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
                type: processedType ?? newUnionType
            });
        }

        if (!processedType) {
            this.processedCustomTypes.set(type.typeRef, newUnionType);

            const unionSchema = this.rootSchema
                .ele("simpleType", { name: newUnionType })
                .ele("union");

            type.members.forEach((member) => {
                if (isPrimitiveTypeKind(member.kind)) {
                    const xsdType = defined(mapPrimitiveKindToXSDTypes.get(member.kind));
                    unionSchema.ele('simpleType').ele('restriction', { base: xsdType });
                } else {
                    panic('Union type with complex types not supported');
                }
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
            unionType => this.renderUnion.bind(this, unionType, prefixes),
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
                    type: defined(this.processedCustomTypes.get(typeRef))
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

        // Get types from XSD file format
        const xsdTypes = new XSDTypes(
            this.xmlFormatConverter.toXMLObjectFromString(xsdString),
            this.targetLanguage.dateTimeRecognizer
        );

        // Parses input JSON to XML
        const xmlString = this.xmlFormatConverter.parseJSON(inputObject, xsdTypes, topLevelName, givenOutputFilename);
        const xmlObject = convert(xmlString, { format: 'object' });
        const json = this.xmlFormatConverter.parseXMLtoJSON(xmlObject, xsdTypes);
        console.log(JSON.stringify(json, null, 4));

        this.emitMultiline(xmlString, 2);
        this.finishFile(`${defined(iterableFirst(givenOutputFilename.split('.')))}.xml`);

        this.emitMultiline(xsdString, 2);
    }
}

export class XSDTypes {
    constructor(private xsdObject: XMLSerializedAsObject, private dateTimeRecognizer: DateTimeRecognizer) {
        this.fetchTypesFromObject();
        this.getTypesStructure();
    }

    private elements: Map<string, string> = new Map();
    private complexTypes: Map<string, XMLObjectType> = new Map();
    private simpleTypes: Map<string, XMLObjectType> = new Map();

    private objectTypes: Map<string, Map<string, ClassProp>> = new Map();
    private arrayTypes: Map<string, ArrayItem> = new Map();
    private unionTypes: Map<string, PrimitiveTypeKind[]> = new Map();

    private objectTypesByPath: Map<string, Map<string, ClassProp>> = new Map();
    private arrayTypesByPath: Map<string, ArrayItem> = new Map();
    private unionTypesByPath: Map<string, PrimitiveTypeKind[]> = new Map();

    public getPrimitiveKindXMLValue = (value: any, kind: PrimitiveTypeKind): string | undefined => {
        switch (kind) {
            case 'integer-string':
            case 'double':
            case 'integer':
                if (!isNaN(+value)) {
                    return Number(value).toString();
                }
                break;
            case 'bool-string':
            case 'bool':
                if (typeof value === 'boolean' || (value === 'true' || value === 'false')) {
                    return value.toString();
                }
                break;
            case 'date':
                if (this.dateTimeRecognizer.isDate(value)) {
                    return value;
                }
                break;
            case 'time':
                if (this.dateTimeRecognizer.isTime(value)) {
                    return value;
                }
                break;
            case 'date-time':
                if (this.dateTimeRecognizer.isDateTime(value)) {
                    return value;
                }
                break;
            case 'uri':
                if (isURI(value)) {
                    return value;
                }
                break;
            case 'any':
            case 'none':
                return '';
            case 'null':
                if (value === null) {
                    return '';
                }
                break;
            case 'string':
                if (typeof value === 'string') {
                    return value;
                }
                break;
        }
    }

    public getPrimitiveKindJSONValue = (value: any, kind: PrimitiveTypeKind):
        number | boolean | string | null | undefined => {
        switch (kind) {
            case 'double':
            case 'integer':
                if (!isNaN(+value)) {
                    return +value;
                }
                break;
            case 'integer-string':
                if (!isNaN(+value)) {
                    return (+value).toString();
                }
                break;
            case 'bool':
                if (typeof value === 'boolean' || (value === 'true' || value === 'false')) {
                    return typeof value === 'boolean' ? value : value === 'true';
                }
                break;
            case 'bool-string':
                if (typeof value === 'boolean' || (value === 'true' || value === 'false')) {
                    return value.toString();
                }
                break;
            case 'date':
                if (this.dateTimeRecognizer.isDate(value)) {
                    return value;
                }
                break;
            case 'time':
                if (this.dateTimeRecognizer.isTime(value)) {
                    return value;
                }
                break;
            case 'date-time':
                if (this.dateTimeRecognizer.isDateTime(value)) {
                    return value;
                }
                break;
            case 'uri':
                if (isURI(value)) {
                    return value;
                }
                break;
            case 'any':
                return value;
            case 'none':
            case 'null':
                if (value == null ||
                    (typeof value === 'object' && Object.keys(value).length === 0)) {
                    return null;
                }
                break;
            case 'string':
                if (typeof value === 'string') {
                    return value;
                } else if (typeof value === 'object' && Object.keys(value).length === 0) {
                    return '';
                }
                break;
        }
    }

    public parseUnion(value: any, unionPath: string, format: ConvertFormatType): string | number | boolean | null {
        const getPrimitiveKindValue = format === 'XML' ?
            this.getPrimitiveKindXMLValue : this.getPrimitiveKindJSONValue;

        const currentKind = defined(this.unionTypesByPath.get(unionPath)).find((kind) => {
            return getPrimitiveKindValue(value, kind) !== undefined;
        });

        if (!currentKind) {
            panic(`Failed parse to XML ${value} with type union`);
        }

        return this.parsePrimitiveKind(value, currentKind, format);
    }

    public parsePrimitiveKind(value: any, kind: PrimitiveTypeKind, format: ConvertFormatType): string | number | boolean | null {
        const getPrimitiveKindValue = format === 'XML' ?
            this.getPrimitiveKindXMLValue : this.getPrimitiveKindJSONValue;

        const processedValue = getPrimitiveKindValue(value, kind);

        if (processedValue === undefined) {
            panic(`Failed parse to XML ${value} with type ${kind}`);
        }

        return processedValue;
    }

    public isValidClassPropsInXMLObject(currentXMLObject: object, path: string) {
        const classData = this.getClassType(path);
        if (!classData) {
            return false;
        }

        return iterableEvery(classData, ([propName, propData]) => {
            const propPath = `${path}.${propName}`;
            if (!(propName in currentXMLObject) && !propData.isOptional) {
                return false;
            }

            if (propData.kind === 'union') {
                return !!this.getUnionType(propPath);
            }
            if (propData.kind === 'array') {
                return !!this.getArrayType(propPath);
            }
            if (propData.kind === 'class') {
                return !!this.getClassType(propPath);
            }
            return isPrimitiveTypeKind(propData.kind);
        });
    }

    public getXMLObjectKind(currentObject: object, path: string) {
        const unionData = this.getUnionType(path);
        const arrayData = this.getArrayType(path);
        const classData = this.getClassType(path);

        if (unionData) {
            return 'union'
        }
        if (arrayData && arrayData.itemTag in currentObject) {
            return 'array';
        }
        if (classData && this.isValidClassPropsInXMLObject(currentObject, path)) {
            return 'class';
        }
    }

    public getUnionType(unionPath: string) {
        const unionStructure = this.unionTypesByPath.get(unionPath);

        if (!unionStructure) {
            return null;
        }

        return unionStructure;
    }

    public getClassType(objectPath: string): Map<string, ClassProp> | null {
        const objectStructure = this.objectTypesByPath.get(objectPath);
        if (!objectStructure) {
            return null
        }

        return objectStructure;
    }

    public getArrayType(arrayPath: string): ArrayItem | null {
        const arrayStructure = this.arrayTypesByPath.get(arrayPath);
        if (!arrayStructure) {
            return null;
        }

        return arrayStructure;
    }

    private get objectInnerTag(): XSDBaseType<'all'> {
        return addXmlnsPrefix('all') as XSDBaseType<'all'>;
    }

    private get arrayInnerTag(): XSDBaseType<'sequence'> {
        return addXmlnsPrefix('sequence') as XSDBaseType<'sequence'>;
    }

    private get unionInnerTag(): XSDBaseType<'union'> {
        return addXmlnsPrefix('union') as XSDBaseType<'union'>;
    }

    private get elementTag(): XSDBaseType<'element'> {
        return addXmlnsPrefix('element') as XSDBaseType<'element'>;
    }

    private isClassType(complexTypeInnerStructure: any, type: string): complexTypeInnerStructure is XSDComplexClassType {
        if (this.objectTypes.has(type)) {
            return true
        }

        if (!complexTypeInnerStructure || !(this.objectInnerTag in complexTypeInnerStructure) ||
            typeof complexTypeInnerStructure[this.objectInnerTag] !== 'object') {
            return false;
        }

        const objectInnerStructure = complexTypeInnerStructure[this.objectInnerTag]
        const objectElements = objectInnerStructure[this.elementTag]
        return typeof objectElements === 'object' || Array.isArray(objectElements);
    }

    private getClassTypeProperties(complexTypeInnerStructure: XSDComplexClassType, type: string):
        Map<string, ClassProp> {
        if (this.objectTypes.has(type)) {
            return defined(this.objectTypes.get(type));
        }

        let elements = complexTypeInnerStructure[this.objectInnerTag][this.elementTag];

        if (!Array.isArray(elements)) {
            elements = [elements];
        }

        const classProps = new Map(elements.map(element => [
            element['@name'],
            {
                type: element['@type'],
                isOptional: Number(element['@minOccurs']) === 0,
                kind: this.getTypeKind(element['@type'])
            }
        ]));

        this.objectTypes.set(type, classProps);

        return classProps;
    }

    private isCustomUnionType(simpleTypeInnerStructure: any, unionType: string):
        simpleTypeInnerStructure is XSDUnionType {
        if (this.unionTypes.get(unionType)) {
            return true;
        }

        if (Array.from(mapXSDTypesToPrimitiveKind.keys()).includes(unionType) ||
            !simpleTypeInnerStructure || !(this.unionInnerTag in simpleTypeInnerStructure)) {
            return false;
        }
        const unionInner = simpleTypeInnerStructure[this.unionInnerTag];

        if (!(addXmlnsPrefix('simpleType') in unionInner)) {
            return false;
        }

        const unionTypes = unionInner[addXmlnsPrefix('simpleType')];

        if (!Array.isArray(unionTypes)) {
            return false
        }

        unionTypes.forEach((typeStructure) => {
            const restrictionTag = typeStructure[addXmlnsPrefix('restriction')];
            if (typeof restrictionTag !== 'object') {
                return false;
            }

            const xsdType = restrictionTag['@base'];

            if (!xsdType || !this.simpleTypes.get(xsdType) || !mapXSDTypesToPrimitiveKind.get(xsdType)) {
                return false;
            }
        });

        return true;
    }

    private isArrayType(complexTypeInnerStructure: any, type: string): complexTypeInnerStructure is XSDComplexArrayType {
        if (this.arrayTypes.has(type)) {
            return true;
        }

        if (!complexTypeInnerStructure || !(this.arrayInnerTag in complexTypeInnerStructure)) {
            return false;
        }
        const arrayInnerStructure = complexTypeInnerStructure[this.arrayInnerTag];
        if (!(this.elementTag in arrayInnerStructure) || typeof arrayInnerStructure[this.elementTag] !== 'object') {
            return false;
        }

        const arrayItem = arrayInnerStructure[this.elementTag];

        return typeof arrayItem === 'object' && arrayItem['@maxOccurs'] === 'unbounded' && +arrayItem['@minOccurs'] === 0
    }

    private getArrayTypeItem(complexTypeInnerStructure: XSDComplexArrayType, type: string): ArrayItem {
        const processedType = this.arrayTypes.get(type);
        if (processedType) {
            return processedType;
        }

        const arrayElement = complexTypeInnerStructure['xsd:sequence']['xsd:element'];
        const itemType = arrayElement['@type'];
        const arrayItemStructure = { itemType, itemTag: arrayElement['@name'], kind: this.getTypeKind(itemType) };
        this.arrayTypes.set(type, arrayItemStructure);

        return arrayItemStructure;
    }

    private getTypeKind(xsdType: string): TypeKind {
        const primitiveKind = mapXSDTypesToPrimitiveKind.get(xsdType);
        if (primitiveKind) {
            return primitiveKind;
        }
        const complexTypeInnerStructure = this.complexTypes.get(xsdType);
        const simpleTypeStructure = this.simpleTypes.get(xsdType);

        if (this.isCustomUnionType(simpleTypeStructure, xsdType)) {
            return "union";
        }

        if (this.isArrayType(complexTypeInnerStructure, xsdType)) {
            return "array";
        }

        if (this.isClassType(complexTypeInnerStructure, xsdType)) {
            return "class";
        }

        return "none";
    }

    private getUnionTypeKinds(unionStructure: XSDUnionType, elementType: string): PrimitiveTypeKind[] {
        if (this.unionTypes.has(elementType)) {
            return defined(this.unionTypes.get(elementType));
        }

        const innerXSDTypes = unionStructure[this.unionInnerTag][addXmlnsPrefix('simpleType')];
        const unionTypeKinds: PrimitiveTypeKind[] = [];

        innerXSDTypes.forEach(innerXSDType => {
            const xsdType = innerXSDType[addXmlnsPrefix('restriction')]['@base'];
            const typeKind = defined(mapXSDTypesToPrimitiveKind.get(xsdType));
            unionTypeKinds.push(typeKind);
        });

        this.unionTypes.set(elementType, unionTypeKinds);

        return unionTypeKinds;
    }

    private getXSDObjectTypesStructure(elementType: string, elementPath: string) {
        const iterateDeep = (kind: TypeKind, type: string, path: string) => {
            if (["class", "array", "union"].includes(kind)) {
                this.getXSDObjectTypesStructure(type, path);
            }
        }
        const complexTypeInnerStructure = this.complexTypes.get(elementType);
        const simpleTypeInnerStructure = this.simpleTypes.get(elementType);

        if (this.isCustomUnionType(simpleTypeInnerStructure, elementType)) {
            const unionTypeKinds = this.getUnionTypeKinds(simpleTypeInnerStructure, elementType);
            this.unionTypesByPath.set(elementPath, unionTypeKinds);
        } else if (this.isArrayType(complexTypeInnerStructure, elementType)) {
            const arrayItem = this.getArrayTypeItem(complexTypeInnerStructure, elementType);

            this.arrayTypesByPath.set(elementPath, arrayItem);

            iterateDeep(arrayItem.kind, arrayItem.itemType, `${elementPath}.${arrayItem.itemTag}`);
        } else if (this.isClassType(complexTypeInnerStructure, elementType)) {
            const classProperties = this.getClassTypeProperties(complexTypeInnerStructure, elementType);

            this.objectTypesByPath.set(elementPath, classProperties);

            classProperties.forEach(({ kind }, tag) =>
                iterateDeep(kind, defined(classProperties.get(tag)?.type), `${elementPath}.${tag}`)
            );
        }
    }

    private getTypesStructure() {
        this.elements.forEach((elementType, elementTag) =>
            this.getXSDObjectTypesStructure(elementType, elementTag)
        )
    }

    private fetchTypesFromObject() {
        const xsdArrayOfObjects = this.xsdObject[addXmlnsPrefix('schema')] as XMLSerializedAsObject;

        this.simpleTypes = this.fetchTag(xsdArrayOfObjects, 'simpleType');
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
