import { XMLFormatConverterHandler, XSDTypes } from './XSD';
import { DefaultDateTimeRecognizer } from '../DateTime';
import { writeFile } from 'fs/promises';

const xmlToJSON = async () => {
    const xmlFormatConverter = new XMLFormatConverterHandler();
    const xsdObject = await xmlFormatConverter.toXMLObjectFromFile('./data/out.xsd');
    const xmlObject = await xmlFormatConverter.toXMLObjectFromFile('./data/out.xml');
    console.log(JSON.stringify(xmlObject, null, 4));
    console.log(JSON.stringify(xsdObject, null, 4));
    const xsdTypes = new XSDTypes(xsdObject, new DefaultDateTimeRecognizer());
    const jsonObject = xmlFormatConverter.parseXMLtoJSON(xmlObject, xsdTypes);
    console.log(jsonObject)
    const stringData = JSON.stringify(jsonObject, null, 4);
    writeFile('./data/convertedJSON.json', stringData);
}

xmlToJSON();