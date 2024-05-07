import { RenderContext, Renderer } from '../Renderer';
import '../ConvenienceRenderer';

import { Option } from 'RendererOptions';
import { TargetLanguage } from '../TargetLanguage';
import { StringTypeMapping, getNoStringTypeMapping } from '../TypeBuilder';
import { allUpperWordStyle, combineWords, firstUpperWordStyle, legalizeCharacters, splitIntoWords } from '../support/Strings';
import { Namer, Namespace, funPrefixNamer } from '../Naming';
import { ArrayType, ClassType, PrimitiveStringTypeKind, PrimitiveType, Type, isPrimitiveStringTypeKind } from '../Type';
import { defined } from '../support/Support';
import xmlbuilder, { XMLElement } from 'xmlbuilder';
import { TypeRef } from '../TypeGraph';
import { mapFirst } from 'collection-utils';
import { matchTypeExhaustive } from '../TypeUtils';

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

type renderType = (schema: XMLElement, key: string, additionalAttrs?: object, createElement?: boolean) => void;

export class XSDRenderer extends Renderer {
    private rootSchema: XMLElement
    private processedComplexTypes: Map<TypeRef, { type: string, elementTags: string[] }> = new Map();
    private mapPrimitiveStringToXSDTypes = new Map<PrimitiveStringTypeKind, string>([
        ["date", this.localSchemaElement("date")],
        ["time", this.localSchemaElement("time")],
        ["date-time", "dateTime"],
        ["uri", this.localSchemaElement("uri")],
        ["integer-string", this.localSchemaElement("integerString")],
        ["bool-string", this.localSchemaElement("booleanString")]
    ]);

    constructor(targetLanguage: TargetLanguage, renderContext: RenderContext) {
        super(targetLanguage, renderContext);

        this.rootSchema = xmlbuilder.create('schema');
        const baseXmlns = "http://www.w3.org/2001/XMLSchema";
        this.rootSchema
            .att(`xmlns:${this.xmlnsPrefix}`, this.schemaNamespace)
            .att("targetNamespace", this.schemaNamespace)
            .att("xmlns", baseXmlns)
            .att("elementFormDefault", "qualified");
    }

    protected genereateBasicTypes() {

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

    private renderNull = (schema: XMLElement, key: string, additionalAttrs: object = {}): void => {
        schema.ele('element', { ...additionalAttrs, name: key, type: `${this.localSchemaElement('nullType')}` });
    }

    private renderBool = (schema: XMLElement, key: string, additionalAttrs: object = {}): void => {
        schema.ele('element', { ...additionalAttrs, name: key, type: 'boolean' });
    }

    private renderInteger = (schema: XMLElement, key: string, additionalAttrs: object = {}): void => {
        schema.ele('element', { ...additionalAttrs, name: key, type: 'integer' });
    }

    private renderDouble = (schema: XMLElement, key: string, additionalAttrs: object = {}): void => {
        schema.ele('element', { ...additionalAttrs, name: key, type: 'decimal' });
    }

    private renderString = (schema: XMLElement, key: string, additionalAttrs: object = {}): void => {
        schema.ele('element', { ...additionalAttrs, name: key, type: 'string' });
    }

    private renderTransformedString = (type: PrimitiveType, schema: XMLElement, key: string, additionalAttrs: object = {}): void => {
        const kind = type.kind;
        if (!isPrimitiveStringTypeKind(kind)) {
            return;
        }
        const xsdType = defined(this.mapPrimitiveStringToXSDTypes.get(kind));

        schema.ele('element', { ...additionalAttrs, name: key, type: xsdType });
    }

    private renderArray = (
        type: ArrayType,
        schema: XMLElement,
        key: string,
        additionalAttrs: object = {},
        createElement = true
    ): void => {
        const processedType = this.processedComplexTypes.get(type.typeRef);
        const elementTags = processedType?.elementTags ?? [];
        const createElementCondition = createElement && ((processedType && !elementTags.includes(key)) || !processedType);
        const arrayType = `${key}ArrayType`;

        if (createElementCondition) {
            this.rootSchema.ele("element", { name: key, type: this.localSchemaElement(processedType?.type ?? arrayType) });
            elementTags.push(key);
        }

        // process inner element of type
        if (schema !== this.rootSchema) {
            schema.ele("element", {
                ...additionalAttrs,
                name: key,
                type: this.localSchemaElement(processedType?.type ?? arrayType)
            });
        }

        if (!processedType) {
            this.processedComplexTypes.set(type.typeRef, { type: arrayType, elementTags });

            const complexTypeSchema = this.rootSchema.ele("complexType", { name: arrayType }).ele("sequence");

            this.renderType(type.items, complexTypeSchema, `${key}Item`, { maxOccurs: "unbounded", minOccurs: "0" }, false);
        }
    }

    private renderClass = (
        type: ClassType,
        schema: XMLElement,
        key: string,
        additionalAttrs: object = {},
        createElement = true
    ): void => {
        const processedType = this.processedComplexTypes.get(type.typeRef);
        const elementTags = processedType?.elementTags ?? [];
        const createElementCondition = createElement && ((processedType && !elementTags.includes(key)) || !processedType);
        const classType = `${key}Type`;

        if (createElementCondition) {
            this.rootSchema.ele("element", { name: key, type: this.localSchemaElement(processedType?.type ?? classType) });
            elementTags.push(key);
        }

        // process inner element of type
        if (schema !== this.rootSchema) {
            schema.ele("element", {
                ...additionalAttrs,
                name: key,
                type: this.localSchemaElement(processedType?.type ?? classType)
            });
        }

        if (!processedType) {
            this.processedComplexTypes.set(type.typeRef, { type: classType, elementTags });

            const complexTypeSchema = this.rootSchema.ele("complexType", { name: classType }).ele("sequence");

            type.getProperties().forEach((innerProp, innerKey) => {
                let derivedElementAttrs = {};
                if (innerProp.isOptional) {
                    derivedElementAttrs = { ...derivedElementAttrs, "minOccurs": 0 };
                }
                this.renderType(innerProp.type, complexTypeSchema, innerKey, derivedElementAttrs);
            });
        }
    }

    private renderType(
        t: Type,
        schema: XMLElement,
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
            arrayType => this.renderArray.bind(this, arrayType),
            classType => this.renderClass.bind(this, classType),
            _mapType => null,
            _objectType => null,
            _enumType => null,
            _unionType => null,
            transformedStringType => this.renderTransformedString.bind(this, transformedStringType)
        );

        return renderCb?.(schema, key, additionalAttrs, createElement);
    }

    private get xmlnsPrefix(): string {
        return "local";
    }

    private get schemaNamespace(): string {
        return "http://example.com/myschema.xsd";
    }

    private localSchemaElement(tag: string): string {
        return `${this.xmlnsPrefix}:${tag}`
    }

    protected emitSource(): void {
        if (this.topLevels.size !== 1) {
            throw Error('Not implemented multiple top levels');
        }

        this.renderType(defined(mapFirst(this.topLevels)), this.rootSchema, "root");

        const res = this.rootSchema.end();
        console.log(res)
    }
}