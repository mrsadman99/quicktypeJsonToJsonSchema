// https://github.com/epoberezkin/ajv/blob/4d76c6fb813b136b6ec4fe74990bc97233d75dea/lib/compile/formats.js

import moment from 'moment';

/*
The MIT License (MIT)

Copyright (c) 2015 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/


export interface DateTimeRecognizer {
    isDate(s: string): boolean;
    isTime(s: string): boolean;
    isDateTime(s: string): boolean;
}

export class DefaultDateTimeRecognizer implements DateTimeRecognizer {
    constructor() {
        moment.locale('ru');
    }

    isDate(str: string) {
        return moment(str, ["LL", "L"], true).isValid();
    }

    isTime(str: string): boolean {
        return moment(str, ["LTS", "LT"], true).isValid();
    }

    isDateTime(str: string): boolean {
        return moment(str, ["lll", "LLL", "LLLL", "llll", moment.ISO_8601], true).isValid();
    }
}
