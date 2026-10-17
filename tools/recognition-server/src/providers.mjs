import { XMLParser } from 'fast-xml-parser';
import { fromCrossref, fromDataCite, fromOpenLibrary, fromArxiv, fromOpenReview,
	isPublished, sameWork, rankCandidates, titleKey } from './metadata.mjs';

/**
 * Public metadata adapters. Only constant provider hosts are reachable; no PDF
 * URL, token, filename, or extracted page text is passed to these services.
 * Inject fetch in tests to validate the contract without contacting providers.
 */
export function createProviders({ fetchImpl = fetch, contact = '', interval = 1000 } = {}) {
	let available = new Map();
	let cooldown = new Map();
	/** Reserve a per-provider request slot, with bounded queueing and no blind retries. */
	async function request(url, xml = false, { deadline = Infinity, timeout = 8000 } = {}) {
		let host = new URL(url).hostname;
		let now = Date.now();
		if ((cooldown.get(host) || 0) > now) throw Object.assign(new Error('Provider rate limited'), { status: 503 });
		let at = Math.max(now, available.get(host) || 0);
		if (at - now > 5000 || at >= deadline) throw Object.assign(new Error('Provider busy'), { status: 503 });
		available.set(host, at + (host == 'export.arxiv.org' ? Math.max(3000, interval) : interval));
		if (at > now) await new Promise(resolve => setTimeout(resolve, at - now));
		let remaining = Math.min(timeout, deadline - Date.now());
		if (remaining <= 0) throw Object.assign(new Error('Provider deadline reached'), { status: 503 });
		let response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(remaining),
			headers: { Accept: xml ? 'application/atom+xml' : 'application/json',
				'User-Agent': `EpiLibRecognition/0.3${contact ? ` (mailto:${contact})` : ''}` } });
		if (response.status == 404) return null;
		if (response.status == 429 || response.status == 503) {
			let retry = response.headers.get('retry-after');
			let seconds = /^\d+$/.test(retry || '') ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
			cooldown.set(host, Date.now() + Math.min(3600, Math.max(60, seconds || 60)) * 1000);
		}
		if (!response.ok) throw Object.assign(new Error('Metadata provider unavailable'), { status: 503 });
		let chunks = [], size = 0;
		for await (let chunk of response.body) {
			size += chunk.length;
			if (size > 2 * 1024 * 1024) throw new Error('Provider response too large');
			chunks.push(chunk);
		}
		let body = Buffer.concat(chunks).toString('utf8');
		if (!xml) return JSON.parse(body);
		if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new Error('Unsafe XML response');
		return new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(body);
	}
	return {
		/** Resolve a canonical identifier and verify returned identity before accepting it. */
		async resolve(kind, id, budget) {
			if (!['doi', 'isbn', 'arxiv'].includes(kind) || typeof id != 'string') return null;
			let identifier = { [kind]: id };
			if (identifier.doi) {
				let data = await request('https://api.crossref.org/works/' + encodeURIComponent(identifier.doi), false, budget);
				if (data) {
					let item = fromCrossref(data.message || {});
					return item?.DOI == identifier.doi ? item : null;
				}
				data = await request('https://api.datacite.org/dois/' + encodeURIComponent(identifier.doi), false, budget);
				let item = data && fromDataCite(data.data?.attributes || {});
				return item?.DOI == identifier.doi ? item : null;
			}
			if (identifier.isbn) {
				let key = 'ISBN:' + identifier.isbn;
				let data = await request('https://openlibrary.org/api/books?format=json&jscmd=data&bibkeys=' + encodeURIComponent(key), false, budget);
				return data ? fromOpenLibrary(data[key], identifier.isbn) : null;
			}
			let data = await request('https://export.arxiv.org/api/query?id_list=' + encodeURIComponent(identifier.arxiv), true, budget);
			let entry = data?.feed?.entry;
			if (Array.isArray(entry)) entry = entry.length == 1 ? entry[0] : null;
			let item = fromArxiv(entry);
			return item?.archiveID == identifier.arxiv ? item : null;
		},
		/**
		 * Search Crossref first, then arXiv when it has no convincing candidate.
		 * arXiv receives a quoted, punctuation-free title, not raw query syntax or
		 * full pages. Author/year corroboration is applied by our ranking policy,
		 * not as a restrictive search filter that can hide preprint versions.
		 * One provider may recover from the other's outage, but outages with no
		 * plausible result remain errors rather than misleading "no match" replies.
		 */
		async search(hints, budget) {
			let items = [], failure;
			let query = new URLSearchParams({ 'query.bibliographic': [hints.title, hints.author, hints.year].filter(Boolean).join(' '), rows: '5' });
			try {
				let data = await request('https://api.crossref.org/works?' + query, false, budget);
				if (data && !Array.isArray(data.message?.items)) throw new Error('Invalid Crossref response');
				items = (data?.message?.items || []).slice(0, 5).map(fromCrossref).filter(Boolean);
			}
			catch (error) { failure = error; }
			// This only decides whether another lookup is useful. The engine still
			// ranks using the ORIGINAL source, so layout hints always require review.
			if (rankCandidates(items, { ...hints, source: 'pdf-metadata' }).status == 'matched') return items;
			query = new URLSearchParams({ search_query: `ti:"${titleKey(hints.title).slice(0, 500)}"`,
				start: '0', max_results: '5', sortBy: 'relevance' });
			try {
				let data = await request('https://export.arxiv.org/api/query?' + query, true, budget);
				if (!data?.feed || typeof data.feed != 'object') throw new Error('Invalid arXiv response');
				let entries = data.feed.entry;
				entries = Array.isArray(entries) ? entries : [entries].filter(Boolean);
				if (entries.some(entry => String(entry.id).includes('/api/errors'))) throw new Error('arXiv query rejected');
				items.push(...entries.slice(0, 5).map(fromArxiv).filter(Boolean));
			}
			catch (error) { failure = error; }
			if (failure && rankCandidates(items, hints).status == 'no_match') throw failure;
			return items;
		},
		/**
		 * Enrich an identified preprint within a shared six-second budget. An arXiv
		 * DOI is tried first; otherwise search Crossref and the public OpenReview
		 * v1/v2 indexes. Only normalized title/complete byline comparisons authorize
		 * an upgrade. No link supplied by a PDF/provider is fetched directly.
		 * Failure is nonfatal and never cached as proof that publication is absent.
		 */
		async publishedVersions(preprint, { deadline = Infinity } = {}) {
			let budget = { deadline: Math.min(deadline, Date.now() + 6000), timeout: 2000 };
			let items = [], incomplete = false;
			async function attempt(url, map) {
				try {
					let data = await request(url, false, budget);
					if (data) items.push(...map(data).filter(item => item && isPublished(item) && sameWork(preprint, item)));
				}
				catch { incomplete = true; }
			}
			let doi = preprint.publicationHints?.doi;
			if (/^10\.\d{4,9}\/\S+$/.test(doi || '')) {
				await attempt('https://api.crossref.org/works/' + encodeURIComponent(doi), data => {
					let item = fromCrossref(data.message);
					return item?.DOI == doi ? [item] : [];
				});
				if (items.length) return { items, incomplete };
			}
			let query = new URLSearchParams({ 'query.title': preprint.title.slice(0, 500),
				'query.author': preprint.creators.map(c => c.name || `${c.firstName} ${c.lastName}`).join('; ').slice(0, 500), rows: '5' });
			await attempt('https://api.crossref.org/works?' + query, data => {
				if (!Array.isArray(data.message?.items)) throw new Error('Invalid Crossref response');
				return data.message.items.slice(0, 5).map(fromCrossref);
			});
			if (items.length) return { items, incomplete };
			query = new URLSearchParams({ term: preprint.title.slice(0, 500), content: 'title', source: 'forum', limit: '5' });
			for (let host of ['api.openreview.net', 'api2.openreview.net']) {
				await attempt(`https://${host}/notes/search?${query}`, data => {
					if (!Array.isArray(data.notes)) throw new Error('Invalid OpenReview response');
					return data.notes.slice(0, 5).map(fromOpenReview);
				});
				if (items.length) break;
			}
			return { items, incomplete };
		}
	};
}
