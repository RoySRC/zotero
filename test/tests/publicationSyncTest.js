/* global describe, it, assert, sinon, createGroup, createDataObject,
	importPDFAttachment, createAnnotation */
"use strict";

/**
 * End-to-end regression for the Neuro-Symbolic paper's disappearing metadata.
 * Catalog lookup and the user's choice are deterministic fixtures; serialization,
 * HTTP, authentication, PostgreSQL, the success-response importer, sync cache and
 * local SQLite persistence all execute their real production implementations.
 */
describe('Publication refresh PostgreSQL integration', function () {
	it('preserves title, collection and children through publication update, server echo and reload', async function () {
		const baseURL = Services.env.get('EPILIB_SYNC_TEST_URL');
		const apiKey = Services.env.get('EPILIB_SYNC_TEST_TOKEN');
		if (!baseURL && !apiKey) this.skip();
		assert.match(baseURL, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'Only use the disposable loopback server');
		assert.isNotEmpty(apiKey);
		const sandbox = sinon.createSandbox();
		const savedEngine = Zotero.Prefs.get('recognize.engine');
		let group;
		try {
			Zotero.Prefs.set('recognize.engine', 'epilib-local');
			group = await createGroup({ id: 991234 });
			const libraryID = group.libraryID;
			const collection = await createDataObject('collection', { libraryID, name: 'Test' });
			const title = 'Neuro-Symbolic AI for Analytical Solutions of Differential Equations';
			const parent = await createDataObject('item', { libraryID, itemType: 'preprint', title,
				collections: [collection.id], tags: [{ tag: 'Keep personal tag' }] });
			parent.setField('archiveID', '2502.01476');
			parent.setField('DOI', '10.48550/arXiv.2502.01476');
			parent.setField('citationKey', 'Oikonomou2025NeuroSymbolic');
			parent.setField('abstractNote', 'Keep the original abstract');
			await parent.saveTx();
			const pdf = await importPDFAttachment(parent);
			const annotation = await createAnnotation('highlight', pdf);
			const note = await createDataObject('item', { libraryID, itemType: 'note', parentID: parent.id });

			const { ConcurrentCaller } = ChromeUtils.importESModule('resource://zotero/concurrentCaller.mjs');
			const client = new Zotero.Sync.APIClient({ baseURL, apiKey, apiVersion: ZOTERO_CONFIG.API_VERSION,
				caller: new ConcurrentCaller({ numConcurrent: 1, stopOnError: true }), background: true });
			const engine = new Zotero.Sync.Data.Engine({ apiClient: client, userID: 1, libraryID, stopOnError: true });
			assert.equal(await engine._startUpload(), engine.UPLOAD_RESULT_SUCCESS);
			const original = parent.toJSON();
			const children = [pdf, annotation, note].map(item => item.toJSON());

			// Keep the same title so the real sync serializer must OMIT it from the
			// update. Older coverage used changed titles and missed this destructive case.
			const record = { itemType: 'conferencePaper', title, date: '2026',
				proceedingsTitle: 'ICML 2026 regular',
				creators: [{ creatorType: 'author', name: 'Orestis Oikonomou' }] };
			sandbox.stub(Zotero.RecognizeDocument, 'queryPDFMetadata').resolves({ status: 'matched', item: record });
			sandbox.stub(Zotero.RecognizeDocument, 'chooseRecognitionCandidate').returns(record);
			assert.isTrue(await Zotero.RecognizeDocument.refreshPublishedMetadata(parent));
			const patch = await engine._getJSONForObject('item', parent.id);
			assert.equal(patch.itemType, 'conferencePaper');
			assert.equal(patch.archiveID, '');
			for (const field of ['title', 'collections', 'citationKey', 'abstractNote', 'tags']) {
				assert.notProperty(patch, field);
			}

			// This upload also applies the server's success record through fromJSON
			// in strict mode. A partial echo or obsolete archiveID must fail this test.
			assert.equal(await engine._startUpload(), engine.UPLOAD_RESULT_SUCCESS);
			await parent.reload(null, true);
			assert.equal(parent.getField('title'), title);
			assert.equal(parent.itemTypeID, Zotero.ItemTypes.getID('conferencePaper'));
			assert.deepEqual(parent.getCollections(), [collection.id]);
			assert.equal(parent.key, original.key);
			assert.equal(parent.getField('DOI'), '');
			assert.isTrue(parent.synced);
			assert.isAbove(parent.version, original.version);
			for (const field of ['citationKey', 'abstractNote']) {
				assert.equal(parent.getField(field), original[field]);
			}
			assert.deepEqual(parent.getTags(), original.tags);
			const cache = await Zotero.Sync.Data.Local.getCacheObject('item', libraryID, parent.key, parent.version);
			assert.equal(cache.data.title, title);
			assert.deepEqual(cache.data.collections, [collection.key]);
			assert.notProperty(cache.data, 'archiveID');
			const response = await Zotero.HTTP.request('GET',
				`${baseURL}groups/${group.id}/items?itemKey=${parent.key}`, {
					headers: { 'Zotero-API-Key': apiKey }, responseType: 'json'
				});
			assert.deepEqual(response.response[0].data, cache.data);
			for (const [index, child] of [pdf, annotation, note].entries()) {
				await child.reload(null, true);
				assert.deepEqual(child.toJSON(), children[index]);
			}
			assert.equal(await engine._startUpload(), engine.UPLOAD_RESULT_NOTHING_TO_UPLOAD);
			assert.equal(parent.getField('title'), title);
			assert.deepEqual(parent.getCollections(), [collection.id]);
		}
		finally {
			sandbox.restore();
			Zotero.Prefs.set('recognize.engine', savedEngine);
			if (group) await group.eraseTx();
		}
	});
});
