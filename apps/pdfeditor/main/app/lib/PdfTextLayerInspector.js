/*
 * Copyright (C) Ascensio System SIA, 2009-2026
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation, together with the
 * implementation of the Apache License version 2.0 as published by the
 * Apache Foundation. See http://www.gnu.org/licenses/agpl-3.0.html
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Classifies the quality of the Khmer text layer of a PDF.
 *
 * A PDF can carry a selectable text layer and still be useless for Khmer: the
 * glyphs are frequently mapped through a legacy custom encoding, so extraction
 * returns a plausible amount of Khmer-looking characters that are mostly wrong
 * (for example the consonant order of a real word is transposed). Counting
 * Khmer characters therefore does not detect the problem, and a corpus of
 * real documents confirmed it: a broken document can contain 90% Khmer
 * codepoints while being unreadable.
 *
 * What does detect it is the Khmer segmenter that already backs Khmer
 * spellchecking in the editors. Every whitespace-delimited word that contains
 * Khmer is passed through the same check the editor applies when
 * underlining a misspelling, and the fraction of words that pass is measured
 * across sampled pages. Documents written by any tool that embeds a correct
 * Unicode text layer pass; broken encodings do not.
 */
define([], function(){
    'use strict';

    var KHMER_RE = /[\u1780-\u17FF]/;
    var COENG = '\u17D2';

    // Sampling and thresholds validated against a corpus of Khmer documents
    // (originals paired with their searchable conversions). The two signals
    // below separate those sets without overlapping.
    var DEFAULTS = {
        basePath: '../../../vendor/pdfjs/',
        samplePages: 8,
        maxCharsPerPage: 8000,
        maxWords: 6000,
        goodPageRatio: 0.6,
        minValidWordRatio: 0.53,
        minGoodPageFrac: 0.30,
        // Below this many Khmer characters a document is not judged on COENG.
        minKhmerCharsForCoengGate: 50
    };

    var STATUS = {
        searchable: 'searchable',
        unreliable: 'unreliable',
        noKhmer: 'no-khmer',
        unknown: 'unknown'
    };

    var pdfjsPromise = null;

    function resolveResourceUrl(url) {
        var result = new URL(url, window.location.href).toString();
        if (window.AscDesktopEditor && 0 === result.indexOf('file:///'))
            return 'ascdesktop://fonts/' + result.substring(8);
        return result;
    }

    function loadText(url) {
        return new Promise(function(resolve, reject){
            var xhr = new XMLHttpRequest();
            xhr.open('GET', resolveResourceUrl(url), true);
            xhr.onload = function(){
                if (xhr.response && (200 === xhr.status || 0 === xhr.status))
                    resolve(xhr.response);
                else
                    reject(new Error('Unable to load ' + url + ' (status ' + xhr.status + ')'));
            };
            xhr.onerror = function(){ reject(new Error('Unable to load ' + url)); };
            xhr.send(null);
        });
    }

    /**
     * pdf.js ships as an ES module. The desktop ascdesktop:// scheme does not
     * return a JavaScript MIME type for these files, so the source is read
     * first and imported from a Blob module instead.
     */
    function defaultLoadPdfJs(basePath) {
        if (pdfjsPromise) return pdfjsPromise;

        pdfjsPromise = loadText(basePath + 'pdf.min.js')
            .then(function(source){
                var moduleUrl = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
                return import(moduleUrl);
            })
            .then(function(pdfjs){
                return loadText(basePath + 'pdf.worker.min.js').then(function(workerText){
                    try {
                        var workerUrl = URL.createObjectURL(new Blob([workerText], {type: 'text/javascript'}));
                        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
                        pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerUrl, {type: 'module'});
                    } catch (error) {
                        // pdf.js falls back to its own worker handling.
                    }
                    return pdfjs;
                });
            })
            .catch(function(error){
                pdfjsPromise = null;
                throw error;
            });

        return pdfjsPromise;
    }

    function defaultGetSpellchecker() {
        var common = window.AscCommon;
        if (!common || 'function' !== typeof common.getKhmerSpellchecker) return null;
        try { return common.getKhmerSpellchecker(); } catch (error) { return null; }
    }

    function pageText(textContent, fontNames) {
        var text = '';
        for (var i = 0; i < textContent.items.length; i++) {
            var item = textContent.items[i];
            if (fontNames && !fontNames[item.fontName]) continue;
            text += item.str + (item.hasEOL ? '\n' : '');
        }
        return text;
    }

    /**
     * A preserved source PDF may have broken Khmer mappings alongside a valid
     * invisible OCR layer. pdf.js gives both streams generic font-family names,
     * so resolve the embedded font objects before identifying the OCR text. The
     * metric precheck avoids parsing operator lists for ordinary documents.
     */
    function logicalLayerText(page, content) {
        var candidates = [], styles = content.styles || {};
        Object.keys(styles).forEach(function(name){
            var style = styles[name];
            if (style && Math.abs(style.ascent - 0.74) < 0.001 &&
                Math.abs(style.descent + 0.26) < 0.001)
                candidates.push(name);
        });
        if (!candidates.length) return Promise.resolve('');

        return page.getOperatorList().then(function(){
            var fonts = {};
            candidates.forEach(function(name){
                try {
                    var font = page.commonObjs.get(name);
                    if (font && /^(?:[A-Z]{6}\+)?TypsastraLogical$/.test(font.name))
                        fonts[name] = true;
                } catch (error) {}
            });
            return pageText(content, fonts);
        }).catch(function(){ return ''; });
    }

    function khmerWords(text) {
        var parts = text.split(/\s+/), words = [], i;
        for (i = 0; i < parts.length; i++)
            if (parts[i] && KHMER_RE.test(parts[i])) words.push(parts[i]);
        return words;
    }

    function sampledPageNumbers(numPages, samplePages) {
        if (numPages <= samplePages) {
            var all = [], p;
            for (p = 1; p <= numPages; p++) all.push(p);
            return all;
        }
        var step = Math.floor(numPages / samplePages), picked = [], q;
        for (q = 1; q <= numPages && picked.length < samplePages; q += step) picked.push(q);
        return picked;
    }

    /**
     * @param {Uint8Array|ArrayBuffer|string} bytes original PDF bytes
     * @param {Object} [options]
     * @returns {Promise<Object>} classification result
     */
    function inspect(bytes, options) {
        options = options || {};

        var cfg = {
            basePath: options.basePath || DEFAULTS.basePath,
            samplePages: options.samplePages || DEFAULTS.samplePages,
            maxCharsPerPage: options.maxCharsPerPage || DEFAULTS.maxCharsPerPage,
            maxWords: options.maxWords || DEFAULTS.maxWords,
            goodPageRatio: isFinite(options.goodPageRatio) ? options.goodPageRatio : DEFAULTS.goodPageRatio,
            minValidWordRatio: isFinite(options.minValidWordRatio) ? options.minValidWordRatio : DEFAULTS.minValidWordRatio,
            minGoodPageFrac: isFinite(options.minGoodPageFrac) ? options.minGoodPageFrac : DEFAULTS.minGoodPageFrac,
            minKhmerCharsForCoengGate: isFinite(options.minKhmerCharsForCoengGate)
                ? options.minKhmerCharsForCoengGate : DEFAULTS.minKhmerCharsForCoengGate
        };

        var result = {
            status: STATUS.unknown,
            validWordRatio: null,
            goodPageFrac: null,
            coengRatio: null,
            khmerChars: 0,
            coengChars: 0,
            sampledPages: 0,
            pagesWithKhmer: 0,
            totalPages: 0
        };

        if (!bytes || !bytes.length)
            return Promise.resolve(result);

        var data = toByteArray(bytes);
        if (!data)
            return Promise.resolve(result);

        var spellchecker = null;
        var document_ = null;
        var totalWords = 0, validWords = 0, pagesWithKhmer = 0, goodPages = 0;
        var loadPdfJs = options.loadPdfJs || defaultLoadPdfJs;
        var getSpellchecker = options.getSpellchecker || defaultGetSpellchecker;

        function finish() {
            if (spellchecker) {
                result.validWordRatio = totalWords ? validWords / totalWords : null;
                result.pagesWithKhmer = pagesWithKhmer;
                result.goodPageFrac = pagesWithKhmer ? goodPages / pagesWithKhmer : null;

                if (result.validWordRatio === null || result.goodPageFrac === null)
                    result.status = STATUS.unknown;
                else
                    result.status = (result.validWordRatio >= cfg.minValidWordRatio &&
                                     result.goodPageFrac >= cfg.minGoodPageFrac)
                                    ? STATUS.searchable : STATUS.unreliable;
            }
            if (document_) {
                try { document_.destroy(); } catch (error) {}
            }
            return result;
        }

        /**
         * The Khmer coeng (subscript) mark is dropped completely by the legacy
         * converters that produce unreadable text layers, while a correct
         * Unicode text layer always carries it. A document with plenty of Khmer
         * but not a single coeng was therefore mapped by such a converter.
         *
         * This is only used as a cheap gate. Plenty of coeng does not prove the
         * text is correct - a converter can emit coeng and still mis-spell the
         * words - so the segmenter remains the authority.
         */
        function countKhmer(text) {
            var khmer = 0, coeng = 0, i, code;
            for (i = 0; i < text.length; i++) {
                code = text.charCodeAt(i);
                if (code < 0x1780 || code > 0x17FF) continue;
                khmer++;
                if (COENG === text.charAt(i)) coeng++;
            }
            return {khmer: khmer, coeng: coeng};
        }

        return loadPdfJs(cfg.basePath)
            .then(function(pdfjs){
                return pdfjs.getDocument({data: data, useSystemFonts: false}).promise;
            })
            .then(function(doc){
                document_ = doc;
                result.totalPages = doc.numPages;

                var numbers = sampledPageNumbers(doc.numPages, cfg.samplePages);
                var texts = [], logicalTexts = [];
                var chain = Promise.resolve();

                numbers.forEach(function(pageNumber){
                    chain = chain.then(function(){
                        return doc.getPage(pageNumber).then(function(page){
                            return page.getTextContent().then(function(content){
                                texts.push(pageText(content).slice(0, cfg.maxCharsPerPage));
                                return logicalLayerText(page, content).then(function(logicalText){
                                    logicalTexts.push(logicalText.slice(0, cfg.maxCharsPerPage));
                                    result.sampledPages++;
                                    page.cleanup();
                                });
                            });
                        });
                    });
                });

                return chain.then(function(){ return {all: texts, logical: logicalTexts}; });
            })
            .then(function(layers){
                // Cheap gate: a document without any Khmer never needs the
                // dictionary, which is a multi-megabyte download.
                var i, khmerChars = 0, coengChars = 0, logicalKhmer = 0;
                var texts = layers.all;
                for (i = 0; i < texts.length; i++) {
                    var counts = countKhmer(texts[i]);
                    khmerChars += counts.khmer;
                    coengChars += counts.coeng;
                    logicalKhmer += countKhmer(layers.logical[i]).khmer;
                }

                // The source text remains selectable, but a substantial OCR
                // layer with its own Unicode font is a better measure of whether
                // Khmer search actually works. A tiny footer in that font is
                // insufficient to excuse an otherwise broken document. The OCR
                // text still has to pass the same COENG and dictionary gates.
                if (logicalKhmer && logicalKhmer >= khmerChars * 0.25) {
                    texts = layers.logical;
                    khmerChars = 0;
                    coengChars = 0;
                    for (i = 0; i < texts.length; i++) {
                        counts = countKhmer(texts[i]);
                        khmerChars += counts.khmer;
                        coengChars += counts.coeng;
                    }
                }

                result.khmerChars = khmerChars;
                result.coengChars = coengChars;
                result.coengRatio = khmerChars ? coengChars / khmerChars : null;

                if (!khmerChars) {
                    result.status = STATUS.noKhmer;
                    return finish();
                }

                // Second cheap gate: Khmer characters but not one coeng.
                if (!coengChars && khmerChars >= cfg.minKhmerCharsForCoengGate) {
                    result.status = STATUS.unreliable;
                    return finish();
                }

                spellchecker = getSpellchecker();
                if (!spellchecker)
                    return finish();

                return spellchecker.init().then(function(){
                    for (var t = 0; t < texts.length; t++) {
                        var words = khmerWords(texts[t]);
                        if (!words.length) continue;

                        pagesWithKhmer++;
                        var ok = 0;
                        for (var w = 0; w < words.length && totalWords < cfg.maxWords; w++, totalWords++)
                            if (spellchecker.checkWord(words[w])) { ok++; validWords++; }

                        if (words.length && ok / Math.min(words.length, cfg.maxWords) >= cfg.goodPageRatio)
                            goodPages++;
                    }
                });
            })
            .then(finish)
            .catch(function(error){
                if (window.console && console.warn)
                    console.warn('Khmer text layer inspection failed', error);
                return result;
            });
    }

    function toByteArray(value) {
        if (!value) return null;
        if ('string' === typeof value) {
            var out = new Uint8Array(value.length);
            for (var i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
            return out;
        }
        if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) {
            // pdf.js rejects Node Buffers, which subclass Uint8Array.
            if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(value))
                return new Uint8Array(value);
            return value;
        }
        if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value);
        if (value.buffer && typeof value.byteLength === 'number')
            return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
        return null;
    }

    return {
        inspect: inspect,
        STATUS: STATUS,
        DEFAULTS: DEFAULTS
    };
});
