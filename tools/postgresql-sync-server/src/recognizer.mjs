/**
 * Identifier-first PDF recognition. This module accepts the desktop PDF worker's
 * JSON, not a PDF file. It neither contacts another service nor stores document
 * contents. A match supplies an identifier to the desktop's existing translators;
 * null means that this engine cannot identify the document confidently.
 *
 * See ../RECOGNITION.md for the wire format, limitations, and extension guide.
 */

/**
 * Reject malformed extraction data with a public, content-free error. Keeping the
 * error independent of input prevents document text from appearing in HTTP logs.
 * @returns {Error} An HTTP 400 error suitable for the recognition router.
 */
function invalidExtraction() {
	return Object.assign(new Error('Invalid PDF extraction data'), { status: 400 });
}

/**
 * Read one page's lines from the PDF worker's positional array format. Word text
 * lives at index 13; coordinates and font information must never be treated as
 * text. Limits bound CPU/memory use even for a deliberately complicated request.
 * @param {Array} page - [width, height, nested text blocks].
 * @returns {string[]} Lines in extractor order, with word spacing preserved.
 */
function pageLines(page) {
	if (!Array.isArray(page) || !Array.isArray(page[2])) throw invalidExtraction();
	let lines = [];
	let nodes = 0;
	let characters = 0;
	/** Traverse layout containers until a word-list is found; never stringify coordinates. */
	function visit(value, depth = 0) {
		if (++nodes > 100000 || depth > 12) throw invalidExtraction();
		if (!Array.isArray(value)) return;
		// A line contains words. Each word has thirteen layout values then text.
		if (value.length && Array.isArray(value[0]) && value[0].length == 14
				&& typeof value[0][13] == 'string') {
			let text = '';
			for (let word of value) {
				if (!Array.isArray(word) || word.length != 14 || typeof word[13] != 'string') {
					throw invalidExtraction();
				}
				characters += word[13].length;
				if (characters > 200000) throw invalidExtraction();
				text += word[13] + (word[5] ? ' ' : '');
			}
			lines.push(text.trim());
			return;
		}
		for (let child of value) visit(child, depth + 1);
	}
	visit(page[2]);
	return lines;
}

/**
 * Normalize DOI punctuation without discarding balanced parentheses, which are
 * legal DOI characters. Matching a DOI alone is not proof it names this paper;
 * recognizeExtraction also restricts where candidates may come from.
 * @param {string} text - A DOI field or a line explicitly labelled DOI.
 * @returns {string[]} Unique lowercase DOI candidates.
 */
function dois(text) {
	return [...new Set((text.match(/10\.\d{4,9}\/[^\s<>"']+/gi) || []).map(value => {
		value = value.replace(/[.,;:]+$/, '');
		for (let [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
			while (value.endsWith(close)
					&& value.split(close).length > value.split(open).length) {
				value = value.slice(0, -1);
			}
		}
		return value.toLowerCase();
	}))];
}

/**
 * Validate ISBN-10/ISBN-13 check digits, ignoring print-format separators. A
 * checksum prevents dates, page numbers, and most OCR mistakes becoming matches.
 * @param {string} value - One candidate ISBN, without an ISBN label.
 * @returns {string|null} Canonical ISBN or null when the checksum is invalid.
 */
function isbn(value) {
	value = value.replace(/[\s-]/g, '').toUpperCase();
	if (/^\d{9}[\dX]$/.test(value)) {
		let sum = [...value].reduce((total, digit, i) => total + (digit == 'X' ? 10 : +digit) * (10 - i), 0);
		return sum % 11 == 0 ? value : null;
	}
	if (/^97[89]\d{10}$/.test(value)) {
		let sum = [...value].reduce((total, digit, i) => total + +digit * (i % 2 ? 3 : 1), 0);
		return sum % 10 == 0 ? value : null;
	}
	return null;
}

/**
 * Parse a labelled identifier field using the same canonical output keys the
 * desktop already understands. Multiple distinct candidates remain distinct so
 * the caller can abstain instead of selecting a possibly unrelated citation.
 * @param {'doi'|'arxiv'|'isbn'} kind - Recognized identifier family.
 * @param {string} text - Explicit metadata field or labelled opening-page line.
 * @returns {string[]} Validated, deduplicated identifiers.
 */
function identifiers(kind, text) {
	if (kind == 'doi') return dois(text);
	if (kind == 'isbn') {
		return [...new Set((text.match(/\b(?:97[89][ -]?)?\d(?:[ -]?\d){8}[ -]?[\dX]\b/gi) || [])
			.map(isbn).filter(Boolean))];
	}
	return [...new Set((text.match(/(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.(?:\d{5}|\d{4}))(?:v\d+)?/gi) || [])
		.map(value => value.replace(/v\d+$/i, '')))];
}

/**
 * Identify a PDF conservatively, preferring explicit PDF metadata identifiers.
 * Without those fields, inspect labelled identifiers in the opening material.
 * Never scan bibliography entries for a match. Multiple candidates of the same
 * family, or competing identifier families, produce null rather than a guess.
 *
 * @param {object} data - Unmodified getRecognizerData output plus optional fileName.
 * @returns {{doi:string}|{arxiv:string}|{isbn:string}|null} Translator input.
 * @throws {Error} HTTP 400 for an invalid/over-budget extraction structure.
 */
export function recognizeExtraction(data) {
	if (!data || typeof data != 'object' || Array.isArray(data)
			|| !Array.isArray(data.pages) || data.pages.length > 5
			|| !Number.isInteger(data.totalPages) || data.totalPages < data.pages.length
			|| (data.metadata !== undefined && (!data.metadata
				|| typeof data.metadata != 'object' || Array.isArray(data.metadata)))) {
		throw invalidExtraction();
	}
	let candidates = new Map();
	// Explicit identifier fields are stronger evidence than a DOI in prose. Do not
	// search Title/Subject or the filename, which often contain unrelated citations.
	for (let [key, value] of Object.entries(data.metadata || {})) {
		let kind = key.toLowerCase().replace(/^(?:prism|dc):/, '').replace(/[-_]/g, '');
		if (!['doi', 'arxiv', 'isbn'].includes(kind) || typeof value != 'string') continue;
		for (let id of identifiers(kind, value)) candidates.set(`${kind}:${id}`, { [kind]: id });
	}
	if (candidates.size) return candidates.size == 1 ? [...candidates.values()][0] : null;

	// DOI/arXiv evidence is restricted to the first page, before the abstract or
	// introduction. ISBNs can also occur on a book's second-page copyright notice.
	for (let [pageIndex, page] of data.pages.slice(0, 2).entries()) {
		let opening = true;
		for (let line of pageLines(page)) {
			if (/^\s*(?:\d+[.\s]+)?(?:references|bibliography)\b/i.test(line)) break;
			if (/^\s*(?:\d+[.\s]+)?(?:abstract|introduction)\b/i.test(line)) opening = false;
			for (let kind of ['doi', 'arxiv', 'isbn']) {
				if (kind != 'isbn' && (pageIndex || !opening)) continue;
				let marker = kind == 'doi' ? /\bdoi\s*:|\b(?:dx\.)?doi\.org\//i
					: kind == 'arxiv' ? /\barxiv\s*:|\barxiv\.org\/(?:abs|pdf)\//i
						: /\bisbn(?:-1[03])?\s*:?\s*/i;
				let match = marker.exec(line);
				if (!match) continue;
				for (let id of identifiers(kind, line.slice(match.index + match[0].length))) {
					candidates.set(`${kind}:${id}`, { [kind]: id });
				}
			}
		}
	}
	return candidates.size == 1 ? [...candidates.values()][0] : null;
}
