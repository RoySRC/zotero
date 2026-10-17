/** Provider records become bounded bibliographic data, never library or sync state. */
const crossrefTypes = {
	'journal-article': 'journalArticle', 'book': 'book', 'monograph': 'book',
	'edited-book': 'book', 'book-chapter': 'bookSection', 'proceedings-article': 'conferencePaper',
	'dissertation': 'thesis', 'report': 'report', 'posted-content': 'preprint'
};

/**
 * Strip provider markup and collapse layout whitespace; never render provider HTML.
 * Most fields are capped at 4,000 characters. Abstracts opt into a larger bound
 * because they legitimately contain more text than titles or identifiers.
 */
export function text(value, limit = 4000) {
	return typeof value == 'string' ? value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

/**
 * Preserve a provider's public landing page without allowing credentials or an
 * executable URL scheme. This function never visits the page: provider lookups
 * still use the fixed API hosts in providers.mjs.
 */
function publicURL(value) {
	try {
		let url = new URL(value);
		return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
			? url.href : '';
	}
	catch { return ''; }
}

/** Convert provider subjects into bounded, deduplicated automatic Zotero tags. */
function subjectTags(subjects) {
	return [...new Set((Array.isArray(subjects) ? subjects : [])
		.map(value => text(value, 255)).filter(Boolean))]
		.slice(0, 100).map(tag => ({ tag, type: 1 }));
}

/**
 * Choose an original bibliographic date, not a later metadata update date.
 * Issued takes priority. Preprints may use Submitted (arXiv's initial submission
 * date); other publications must not confuse peer-review submission with issue.
 * Preserve the supplied precision and fall back to the publication year.
 */
function dataCiteDate(work, itemType) {
	let dates = Array.isArray(work.dates) ? work.dates : [];
	let order = itemType == 'preprint' ? ['Issued', 'Submitted', 'Available'] : ['Issued', 'Available'];
	for (let type of order) {
		let date = dates.find(entry => entry?.dateType == type && typeof entry.date == 'string')?.date;
		if (date) return text(date).replace(/T\d{2}:.*$/, '');
	}
	return String(work.publicationYear || '');
}

/** Normalize title comparison independently of capitalization and punctuation. */
export function titleKey(value) {
	return text(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Preserve names explicitly structured by the provider, including organizations. */
function creators(authors = []) {
	return (Array.isArray(authors) ? authors : []).slice(0, 200).flatMap(author => {
		if (!author || typeof author != 'object') return [];
		if (author.family) return [{ creatorType: 'author', firstName: text(author.given), lastName: text(author.family) }];
		if (author.name) return [{ creatorType: 'author', name: text(author.name) }];
		return [];
	});
}

/** Convert a Crossref work to desktop item JSON; unsupported work types abstain. */
export function fromCrossref(work) {
	if (!work || typeof work != 'object') return null;
	let itemType = Object.hasOwn(crossrefTypes, work.type) ? crossrefTypes[work.type] : null;
	let title = Array.isArray(work.title) ? text(work.title[0]) : '';
	let doi = text(work.DOI).toLowerCase();
	if (!itemType || !title || !/^10\.\d{4,9}\/\S+$/.test(doi) || doi.length > 500) return null;
	let parts = (work.published || work.issued)?.['date-parts']?.[0] || [];
	let item = { itemType, title, creators: creators(work.author), DOI: doi,
		date: parts.join('-'), libraryCatalog: 'Crossref' };
	if (work.abstract) item.abstractNote = text(work.abstract, 20000);
	if (work.language) item.language = text(work.language);
	if (work.subject) item.tags = subjectTags(work.subject);
	if (itemType == 'journalArticle') {
		item.publicationTitle = text(work['container-title']?.[0]);
		item.volume = text(work.volume);
		item.issue = text(work.issue);
		item.ISSN = text(work.ISSN?.[0]);
	}
	if (itemType == 'bookSection') item.bookTitle = text(work['container-title']?.[0]);
	if (itemType == 'conferencePaper') item.proceedingsTitle = text(work['container-title']?.[0]);
	if (['book', 'bookSection', 'conferencePaper', 'report'].includes(itemType)) item.publisher = text(work.publisher);
	if (['book', 'bookSection', 'conferencePaper'].includes(itemType)) item.ISBN = text(work.ISBN?.[0]);
	if (['journalArticle', 'bookSection', 'conferencePaper'].includes(itemType)) item.pages = text(work.page);
	item.url = 'https://doi.org/' + encodeURIComponent(item.DOI).replace(/%2F/gi, '/');
	return item;
}

/**
 * Map DataCite's supported publications without discarding descriptive metadata.
 * Abstract is a typed description, subjects become automatic tags, and license
 * names stay in rights. None of these values can introduce child items or IDs.
 * For arXiv preprints, the explicitly supplied arXiv identifier populates the
 * archive field independently of the DOI. A DOI alone is not enough to infer a
 * repository or a publication date that the provider did not actually supply.
 */
export function fromDataCite(work) {
	if (!work || typeof work != 'object') return null;
	let itemType = { JournalArticle: 'journalArticle', Book: 'book', BookChapter: 'bookSection',
		Dissertation: 'thesis', Report: 'report', Preprint: 'preprint', ConferencePaper: 'conferencePaper' }[work.types?.resourceTypeGeneral];
	if (typeof itemType != 'string' || !work.doi || !work.titles?.[0]?.title) return null;
	let item = { itemType, title: text(work.titles[0].title), DOI: text(work.doi).toLowerCase(),
		creators: creators((work.creators || []).map(a => ({ given: a.givenName, family: a.familyName, name: a.name }))),
		date: dataCiteDate(work, itemType), libraryCatalog: 'DataCite',
		url: publicURL(work.url) || 'https://doi.org/' + encodeURIComponent(work.doi).replace(/%2F/gi, '/') };
	let descriptions = Array.isArray(work.descriptions) ? work.descriptions : [];
	let abstract = descriptions.find(entry => entry?.descriptionType == 'Abstract');
	if (abstract) item.abstractNote = text(abstract.description, 20000);
	if (work.language) item.language = text(work.language);
	let rights = Array.isArray(work.rightsList) ? work.rightsList : [];
	let licenses = rights.map(entry => text(entry?.rights) || publicURL(entry?.rightsUri)).filter(Boolean);
	if (licenses.length) item.rights = text([...new Set(licenses)].join('; '));
	if (Array.isArray(work.subjects)) item.tags = subjectTags(work.subjects.map(entry => entry?.subject));
	let publisher = text(typeof work.publisher == 'object' ? work.publisher?.name : work.publisher);
	if (publisher) {
		if (itemType == 'preprint') item.repository = publisher;
		else if (itemType == 'thesis') item.university = publisher;
		else if (itemType == 'report') item.institution = publisher;
		else if (['book', 'bookSection', 'conferencePaper'].includes(itemType)) item.publisher = publisher;
	}
	let identifiers = Array.isArray(work.identifiers) ? work.identifiers : [];
	let arxiv = identifiers.find(entry => typeof entry?.identifierType == 'string'
		&& entry.identifierType.toLowerCase() == 'arxiv');
	if (itemType == 'preprint' && typeof arxiv?.identifier == 'string'
			&& /^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?$/i.test(arxiv.identifier)) {
		item.archiveID = 'arXiv:' + arxiv.identifier;
		item.repository = 'arXiv';
	}
	return item;
}

/** Open Library returns edition metadata; keep unsplit author names losslessly. */
export function fromOpenLibrary(work, isbn) {
	if (!work?.title) return null;
	return { itemType: 'book', title: text(work.title), ISBN: isbn,
		creators: creators(work.authors), date: text(work.publish_date),
		publisher: text(work.publishers?.[0]?.name), libraryCatalog: 'Open Library' };
}

/**
 * Normalize one arXiv Atom entry for both identifier and title searches. Require
 * an arXiv record URL with a syntactically valid ID: Atom error entries and
 * unexpected hosts must never become bibliographic candidates.
 */
export function fromArxiv(entry) {
	let match = text(entry?.id).match(/^https?:\/\/arxiv\.org\/abs\/((?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7}))(?:v\d+)?$/i);
	let title = text(entry?.title);
	if (!match || !title) return null;
	let authors = Array.isArray(entry.author) ? entry.author : [entry.author].filter(Boolean);
	let item = { itemType: 'preprint', title,
		creators: authors.map(author => ({ creatorType: 'author', name: text(author?.name) }))
			.filter(author => author.name).slice(0, 200),
		abstractNote: text(entry.summary, 20000), date: text(entry.published).slice(0, 10),
		archiveID: match[1], repository: 'arXiv', url: 'https://arxiv.org/abs/' + match[1],
		libraryCatalog: 'arXiv' };
	// These are lookup hints, not proof of publication. Keep the original arXiv
	// date/type until an independent provider confirms the published record.
	item.publicationHints = { doi: text(entry.doi, 500).toLowerCase(),
		journalReference: text(entry.journal_ref, 1000), comment: text(entry.comment, 1000) };
	return item;
}

/**
 * Map accepted OpenReview conference records from both API generations. API 1
 * uses plain content values; API 2 wraps each in {value}. Submission timestamps
 * are deliberately ignored: only the venue year is a reliable publication date.
 * A BibTeX @inproceedings entry alone does NOT establish acceptance.
 */
export function fromOpenReview(note) {
	let value = key => note?.content?.[key]?.value ?? note?.content?.[key];
	let venue = text(value('venue'));
	let venueID = text(value('venueid'));
	let invitations = [note?.invitation, ...(Array.isArray(note?.invitations) ? note.invitations : [])].filter(Boolean);
	let year = venueID.match(/\/(20\d{2})\/(?:Conference|Main)$/i)?.[1];
	let forum = note?.forum || note?.id;
	if (!year || !venue || !text(value('title')) || !/^[\w-]{1,100}$/.test(forum || '')
			|| !Array.isArray(value('authors')) || !value('authors').length
			|| /submitted|submission|withdrawn|reject|under.?review|desk.?reject/i.test(venue)
			|| invitations.some(id => /(?:withdrawn|rejected)_submission|dblp\.org/i.test(id))
			|| /^dblp\.org\//i.test(venueID)) return null;
	return { itemType: 'conferencePaper', title: text(value('title')),
		creators: creators(value('authors').map(name => ({ name }))), date: year,
		proceedingsTitle: venue.replace(/\s+(?:poster|oral|spotlight)$/i, ''),
		abstractNote: text(value('abstract'), 20000), libraryCatalog: 'OpenReview',
		url: 'https://openreview.net/forum?id=' + forum };
}

/** Only independently catalogued journal/conference records can replace a preprint. */
export function isPublished(item) {
	return !!((item.itemType == 'conferencePaper' && item.proceedingsTitle)
		|| (item.itemType == 'journalArticle' && item.publicationTitle))
		&& !!(item.DOI || item.url);
}

/**
 * Compare complete bylines, tolerating initials/middle names but not different
 * full given names. Exact normalized titles and equal author counts are required;
 * uncertain title revisions or incomplete author lists remain separate choices.
 */
export function sameWork(a, b) {
	if (!titleKey(a.title) || titleKey(a.title) != titleKey(b.title)) return false;
	/** Compare structured names and common unsplit bylines without requiring middle names. */
	function names(item) {
		return (item.creators || []).filter(c => c.creatorType == 'author').map(c => {
			let parts = titleKey(c.name || '').split(' ');
			let comma = c.name?.split(',');
			return { family: titleKey(c.lastName || (comma?.length == 2 ? comma[0] : parts.pop())),
				given: titleKey(c.firstName || (comma?.length == 2 ? comma[1] : parts.join(' '))).split(' ')[0] };
		});
	}
	let left = names(a), right = names(b);
	if (!left.length || left.length != right.length) return false;
	for (let author of left) {
		let index = right.findIndex(other => author.family && author.family == other.family
			&& author.given && other.given && (author.given == other.given
				|| (Math.min(author.given.length, other.given.length) == 1 && author.given[0] == other.given[0])));
		if (index < 0) return false;
		right.splice(index, 1);
	}
	return true;
}

/** Retain the preprint as an alternate identifier without copying its date/venue. */
export function publishedVersion(preprint, publication) {
	let arxiv = text(preprint.archiveID).replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
	return { ...publication, ...(/^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})$/i.test(arxiv)
		? { alternateIdentifiers: { arxiv } } : {}) };
}

/** A dated venue banner can veto automatic acceptance, never establish it. */
export function publicationConflict(hint, item) {
	let year = hint.match(/\b(?:19|20)\d{2}\b/)?.[0];
	let acronym = hint.match(/\b([A-Z][A-Z0-9]{1,12})\s+(?:19|20)\d{2}\b/)?.[1];
	let venue = titleKey(item.proceedingsTitle || item.publicationTitle || '');
	return !!((year && item.date && item.date.slice(0, 4) != year)
		|| (acronym && venue && !(` ${venue} `).includes(` ${acronym.toLowerCase()} `)));
}

/**
 * Rank title-search results using observable evidence, not provider relevance
 * scores presented as probabilities. Auto-accept requires exact normalized title,
 * author corroboration, and no close competing result. Layout guesses need review.
 */
export function rankCandidates(items, hints) {
	items = items.map(item => {
		let repository = isPublished(item) && items.find(candidate => candidate.itemType == 'preprint' && sameWork(candidate, item));
		return repository ? publishedVersion(repository, item) : item;
	});
	// Collapse only an unambiguous, corroborated repository/publication pair.
	// Two plausible published versions must both remain available for review.
	items = items.flatMap(item => {
		if (item.itemType != 'preprint') return [item];
		let publications = items.filter(candidate => isPublished(candidate) && sameWork(item, candidate));
		return publications.length == 1 ? [] : [item];
	});
	let wanted = titleKey(hints.title);
	let tokens = new Set(wanted.split(' ').filter(Boolean));
	let candidates = items.map(item => {
		let found = titleKey(item.title);
		let other = new Set(found.split(' ').filter(Boolean));
		let shared = [...tokens].filter(t => other.has(t)).length;
		let similarity = shared / Math.max(1, new Set([...tokens, ...other]).size);
		let author = titleKey(hints.author);
		let authorMatch = !!author && item.creators.some(c => {
			let name = titleKey(c.lastName || c.name);
			return name.length >= 3 && (' ' + author + ' ').includes(' ' + name + ' ');
		});
		let yearMatch = !!hints.year && item.date?.slice(0, 4) == hints.year;
		let yearConflict = !!hints.year && !!item.date && item.date.slice(0, 4) != hints.year;
		return { item, evidence: { exactTitle: wanted == found, authorMatch, yearMatch, yearConflict, titleSimilarity: similarity },
			score: similarity * 0.8 + (authorMatch ? 0.15 : 0) + (yearMatch ? 0.05 : 0) };
	}).filter(c => c.evidence.titleSimilarity >= 0.5).sort((a, b) => b.score - a.score);
	let best = candidates[0];
	let matched = best && hints.source != 'layout' && best.evidence.exactTitle
		&& best.evidence.authorMatch && !best.evidence.yearConflict
		&& (!candidates[1] || best.score - candidates[1].score >= 0.1);
	return { status: matched ? 'matched' : candidates.length ? 'needs_review' : 'no_match',
		...(matched ? { item: best.item, evidence: best.evidence } : { candidates: candidates.slice(0, 5) }) };
}
