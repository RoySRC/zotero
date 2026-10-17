/**
 * Identifier-first PDF recognition. This module accepts the desktop PDF worker's
 * JSON, not a PDF file. It neither contacts another service nor stores document
 * contents. A match supplies an identifier to the worker's public-data providers;
 * null means that an identifier could not be selected confidently.
 *
 * See ../README.md for the wire format, limitations, and extension guide.
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
 * @returns {object[]} Text, font, emphasis and vertical bounds in extractor order.
 */
function pageLayout(page) {
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
			let weight = 0, fontTotal = 0, boldTotal = 0;
			let top = Infinity, bottom = -Infinity;
			for (let word of value) {
				if (!Array.isArray(word) || word.length != 14 || typeof word[13] != 'string') {
					throw invalidExtraction();
				}
				characters += word[13].length;
				if (characters > 200000) throw invalidExtraction();
				text += word[13] + (word[5] ? ' ' : '');
				if (Number.isFinite(word[1])) top = Math.min(top, word[1]);
				if (Number.isFinite(word[3])) bottom = Math.max(bottom, word[3]);
				// Character weighting keeps a superscript or one large initial from
				// determining the font size of an otherwise ordinary line.
				if (Number.isFinite(word[4]) && word[4] > 0 && word[4] < 200) {
					let length = word[13].length;
					weight += length;
					fontTotal += word[4] * length;
					boldTotal += word[9] ? length : 0;
				}
			}
			lines.push({ text: text.trim(), fontSize: weight ? fontTotal / weight : 0,
				bold: weight ? boldTotal / weight : 0, top, bottom });
			return;
		}
		for (let child of value) visit(child, depth + 1);
	}
	visit(page[2]);
	return lines;
}

/** Keep identifier extraction independent of the optional typography hints. */
export function pageLines(page) {
	return pageLayout(page).map(line => line.text);
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
 * @param {Function} [onAmbiguous] - Notifies the engine that review is required.
 * @returns {{doi:string}|{arxiv:string}|{isbn:string}|null} Provider identifier.
 * @throws {Error} HTTP 400 for an invalid/over-budget extraction structure.
 */
export function recognizeExtraction(data, onAmbiguous = () => {}) {
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
	if (candidates.size) {
		if (candidates.size > 1) onAmbiguous();
		return candidates.size == 1 ? [...candidates.values()][0] : null;
	}

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
	if (candidates.size > 1) onAmbiguous();
	return candidates.size == 1 ? [...candidates.values()][0] : null;
}

/** Recognize opening-page furniture, not arbitrary occurrences inside a title. */
function isHeaderFurniture(value) {
	return /^(?:published as|under review|submitted (?:to|as|for)|accepted (?:at|by|for)|proceedings of|copyright|all rights reserved|preprint(?:\s|$)|arxiv\s*:|https?:|doi\s*:|isbn\b)/i.test(value)
		|| /@|\bdoi\.org\//i.test(value);
}

/** Stop before body prose and references can become title/author search hints. */
function isBodyHeading(value) {
	return /^(?:\d+[.\s]+)?(?:abstract|introduction|references|bibliography)\b/i.test(value);
}

/**
 * Extract conservative personal-name hints from a byline, never from the body.
 * Affiliations and emails are excluded. This is a search aid, not an authoritative
 * author parser: unsupported scripts/naming conventions simply remain unknown.
 */
function bylineNames(value) {
	if (isHeaderFurniture(value) || /\b(?:university|institute|department|school|laboratory|labs?|research|college|center|centre|UCSD|CSE|IBM|MIT)\b/i.test(value)) return [];
	return value.replace(/[\d*\u2020\u2021]+/g, '').split(/\s*(?:,|;|&|\band\b)\s*/i).filter(name => {
		let parts = name.trim().split(/\s+/);
		return parts.length >= 2 && parts.length <= 6 && parts.every(part =>
			/^(?:\p{Lu}[\p{Ll}\p{M}'\u2019]+(?:-\p{Lu}[\p{Ll}\p{M}]+)*|\p{Lu}\.|van|von|de|del|da|di|der)$/u.test(part));
	}).map(name => name.trim());
}

/**
 * Locate a title in the opening header using font prominence and reading order.
 * Join adjacent title lines only when typography and spacing agree; do not join
 * an author byline or affiliation. All such guesses remain review-only, even
 * when a provider returns an exact title, until validated on a broader corpus.
 */
function layoutHints(page) {
	let lines = pageLayout(page).filter(line => line.text);
	let end = lines.findIndex(line => isBodyHeading(line.text));
	lines = lines.slice(0, end < 0 ? 35 : Math.min(end, 35));
	let candidates = lines.slice(0, 20).map((line, index) => ({ ...line, index }))
		.filter(line => line.text.length >= 15 && line.text.length <= 250
			&& !isHeaderFurniture(line.text)
			&& (!Number.isFinite(page[1]) || line.top < page[1] * 0.55));
	// Large/bold type is evidence, but the early-page preference breaks ties on
	// PDFs whose extractor gives the title and byline identical font sizes.
	candidates.sort((a, b) => (b.fontSize + b.bold - b.index * 0.15)
		- (a.fontSize + a.bold - a.index * 0.15));
	let best = candidates[0];
	if (!best) return { title: '', author: '', year: '' };
	let ordinaryFont = Math.min(...lines.map(line => line.fontSize).filter(size => size > 0));
	let start = best.index, last = best.index;
	/** A continuation must be physically adjacent and typographically similar. */
	function continues(left, right) {
		return left && right && !isHeaderFurniture(right.text) && !isHeaderFurniture(left.text)
			&& (!bylineNames(right.text).length || right.fontSize > ordinaryFont * 1.15)
			&& (!bylineNames(left.text).length || left.fontSize > ordinaryFont * 1.15)
			&& left.fontSize > 0 && Math.abs(left.fontSize - right.fontSize) <= left.fontSize * 0.15
			&& right.top >= left.top && right.top - left.bottom <= left.fontSize * 1.5;
	}
	while (start > 0 && last - start < 2 && continues(lines[start - 1], lines[start])) start--;
	while (last + 1 < lines.length && last - start < 2 && continues(lines[last], lines[last + 1])) last++;
	let title = lines.slice(start, last + 1).map(line => line.text).join(' ')
		.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
	let author = [...new Set(lines.slice(last + 1, last + 19).flatMap(line => bylineNames(line.text)))].join('; ');
	let banner = lines.find(line => /^(?:published as|accepted (?:at|by|for)|proceedings of)/i.test(line.text));
	let year = banner?.text.match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
	return { title, author, year };
}

/**
 * Prefer explicit metadata/local GROBID hints, otherwise use the opening header.
 * Only bounded title/author/year clues leave this worker. A layout-derived title
 * or byline cannot promote a candidate to automatic acceptance.
 */
export function getHints(data) {
	let local = data.hints || {};
	if (typeof local != 'object' || Array.isArray(local)) throw invalidExtraction();
	let title = [local.title, data.metadata?.Title, data.metadata?.title]
		.find(value => typeof value == 'string' && value.trim())?.trim();
	let author = [local.author, data.metadata?.Author, data.metadata?.author]
		.find(value => typeof value == 'string' && value.trim())?.trim();
	let year = String(local.year || '');
	let source = typeof local.title == 'string' && local.title.trim() ? 'local-grobid' : title ? 'pdf-metadata' : 'layout';
	if (data.pages[0] && (!title || !author)) {
		let layout = layoutHints(data.pages[0]);
		if (!title) title = layout.title;
		if (!author && layout.author) {
			author = layout.author;
			source = 'layout';
		}
		if (!year) year = layout.year;
	}
	return {
		title: typeof title == 'string' ? title.trim().slice(0, 500) : '',
		author: typeof author == 'string' ? author.trim().slice(0, 200) : '',
		year: /^\d{4}$/.test(year) ? year : '', source
	};
}

/**
 * Keep publication banners separate from title/author evidence. Only the opening
 * page before body headings is considered, so a cited conference is never used
 * as this paper's venue. A banner helps detect contradictions; it cannot prove
 * acceptance or manufacture a published item on its own.
 */
export function getPublicationHint(data) {
	if (!data.pages[0]) return '';
	let lines = pageLines(data.pages[0]).slice(0, 35);
	let end = lines.findIndex(isBodyHeading);
	return (end < 0 ? lines : lines.slice(0, end))
		.find(line => /^(?:published as|accepted (?:at|by|for)|proceedings of)/i.test(line))?.slice(0, 500) || '';
}
