import { recognizeExtraction, getHints, getPublicationHint } from './extraction.mjs';
import { rankCandidates, isPublished, sameWork, publishedVersion, publicationConflict } from './metadata.mjs';
import { createHash } from 'node:crypto';

/**
 * Compose extraction, public-data lookup, and conservative matching. "local"
 * never calls a provider; "hybrid" tries the local index first; "online" uses
 * providers with a positive identifier cache. Dependencies are injected so tests
 * never need to send private document data over the network.
 */
export function createEngine({ providers, store, mode = 'online' }) {
	if (!['online', 'local', 'hybrid'].includes(mode)) throw new Error('Invalid LOOKUP_MODE');
	return async function recognize(data) {
		let budget = { deadline: Date.now() + 22000 };
		let ambiguous = false;
		let identifier = recognizeExtraction(data, () => { ambiguous = true; });
		let hints = getHints(data);
		let publicationHint = getPublicationHint(data);
		// Conflicting identifiers must not be hidden by an otherwise plausible title.
		if (ambiguous) hints.source = 'layout';
		let envelope = { engine: 'epilib', version: 2 };
		/**
		 * Keep identifier caches as source records and cache positive publication
		 * relationships separately. A cached preprint still gets enrichment; misses
		 * and outages do not suppress future attempts. Only public records are saved.
		 */
		async function enrich(item) {
			if (item.itemType != 'preprint' || mode == 'local' || !providers.publishedVersions) return { items: [item] };
			// Arrays give the fingerprint a stable order even after PostgreSQL jsonb
			// reorders provider-object keys on a warm-cache read.
			let byline = item.creators.map(c => [c.creatorType, c.name || '', c.firstName || '', c.lastName || '']);
			let key = 'publication-v1:' + createHash('sha256')
				.update(JSON.stringify([item.DOI || item.archiveID || item.url, item.title, byline])).digest('hex');
			let result = await store.get(key);
			let cached = !!result;
			if (!result) {
				try { result = await providers.publishedVersions(item, budget); }
				catch { result = { items: [], incomplete: true }; }
			}
			let publications = [...new Map((result.items || [])
				.filter(candidate => isPublished(candidate) && sameWork(item, candidate))
				.map(candidate => [candidate.DOI || candidate.url, publishedVersion(item, candidate)])).values()];
			if (publications.length && !cached) await store.put(key, { items: publications });
			return { items: publications.length ? publications : [item],
				evidence: { publicationLookup: result.incomplete ? 'incomplete' : 'complete',
					...(publications.length ? { repositoryVersion: item.url, sameWork: true } : {}) } };
		}
		if (identifier) {
			let [kind, id] = Object.entries(identifier)[0];
			// Older projections dropped publication hints. Bypass them so a cached
			// repository record cannot hide a newly available publication DOI.
			let key = `bibliography-v3:${kind}:${id}`;
			// Offline mode ignores online cache entries, making evaluation reproducible.
			let item = mode != 'local' ? await store.get(key) : null;
			if (!item && mode != 'online' && kind == 'doi') item = await store.localDOI(id);
			if (!item && mode != 'local') {
				item = await providers.resolve(kind, id, budget);
				if (item) await store.put(key, item);
			}
			if (item) {
				if (!publicationHint && /^(?:published|accepted)\b/i.test(item.publicationHints?.comment || '')) {
					publicationHint = item.publicationHints.comment;
				}
				let evidence = { method: 'identifier', identifier, provider: item.libraryCatalog };
				// A strong explicit title contradiction warrants human review even if
				// an identifier resolves. Layout guesses are not strong enough to veto it.
				if (hints.title && hints.source != 'layout'
						&& rankCandidates([item], hints).status == 'no_match') {
					return { ...envelope, status: 'needs_review', candidates: [{ item, evidence: { ...evidence, titleConflict: true } }] };
				}
				let enriched = await enrich(item);
				evidence = { ...evidence, ...enriched.evidence };
				let selected = enriched.items[0];
				// An explicit publication banner with no confirmed publication, or
				// multiple published versions, needs a human choice rather than a guess.
				if (enriched.items.length > 1 || (publicationHint && selected.itemType == 'preprint')
						|| publicationConflict(publicationHint, selected) || ambiguous) {
					return { ...envelope, status: 'needs_review', candidates: enriched.items.slice(0, 5).map(item => ({ item, evidence })) };
				}
				return { ...envelope, status: 'matched', item: selected, evidence: { ...evidence, provider: selected.libraryCatalog } };
			}
		}
		if (hints.title.length < 15) return { ...envelope, status: 'no_match' };
		let items = mode != 'online' ? await store.search(hints.title) : [];
		if (!items.length && mode != 'local') items = await providers.search(hints, budget);
		// Enrich only the strongest plausible repository candidate. This bounds
		// added requests and cannot auto-accept layout-derived title guesses.
		let ranked = rankCandidates(items, hints);
		let best = ranked.item || ranked.candidates?.[0]?.item;
		if (best?.itemType == 'preprint') {
			let enriched = await enrich(best);
			items = items.filter(item => item != best).concat(enriched.items);
		}
		let unique = [...new Map(items.map(item => [item.DOI || item.ISBN || item.url, item])).values()];
		let result = rankCandidates(unique, hints);
		if (result.status == 'matched' && (publicationConflict(publicationHint, result.item)
				|| (publicationHint && result.item.itemType == 'preprint'))) {
			result = { status: 'needs_review', candidates: [{ item: result.item, evidence: result.evidence }] };
		}
		return { ...envelope, ...result };
	};
}
