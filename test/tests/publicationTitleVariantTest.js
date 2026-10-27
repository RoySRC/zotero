/* global describe, beforeEach, afterEach, it, assert, sinon, createDataObject,
 importPDFAttachment, createAnnotation, waitForWindow */
"use strict";

/**
 * End-to-end reproduction of the SymTorch title-revision failure. Only catalog
 * HTTP responses are replaced: the packaged worker, native SQLite cache, desktop
 * response validator, modal review dialog, and library transaction are real.
 * Everything runs in the test profile, never in the user's SFU-PhD collection.
 */
describe('Publication title variant review', function () {
	this.timeout(60000);
	const title = 'SymTorch: Symbolic Distillation of Neural Networks';
	const publishedTitle = 'SymTorch: A Framework for Symbolic Distillation of Deep Neural Networks';
	const authors = ['Elizabeth S.Z. Tan', 'Adil Soubki', 'Miles Cranmer'];
	const names = ['recognize.engine', 'recognize.repository.enabled'];
	let sandbox, saved, client, cachePath, parent, collection, attachment, annotation;

	beforeEach(async function () {
		sandbox = sinon.createSandbox();
		saved = names.map(name => [name, Zotero.Prefs.get(name)]);
		Zotero.Prefs.set('recognize.engine', 'epilib-local');
		Zotero.Prefs.set('recognize.repository.enabled', false);
		cachePath = PathUtils.join(PathUtils.tempDir, 'epilib-variant-' + Zotero.Utilities.randomString() + '.sqlite');
		client = new Zotero.LocalRecognitionClient({ cachePath });
		sandbox.stub(Zotero.LocalRecognition, 'recognize').callsFake((...args) => client.recognize(...args));
		sandbox.stub(Zotero.RecognizeDocument, 'getProviderCredentials').resolves({});
		sandbox.stub(Zotero.HTTP, 'request').callsFake(async (method, url) => {
			let status = 200, body;
			if (url.startsWith('https://export.arxiv.org/')) {
				body = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
					<id>https://arxiv.org/abs/2602.21307v2</id><title>${title}</title>
					<published>2026-02-24T00:00:00Z</published>
					${authors.map(name => `<author><name>${name}</name></author>`).join('')}</entry></feed>`;
			}
			else if (url.startsWith('https://api.crossref.org/')) body = JSON.stringify({ message: { items: [] } });
			else if (url.startsWith('https://api.openreview.net/')) body = JSON.stringify({ notes: [] });
			else if (url.startsWith('https://api2.openreview.net/')) {
				body = JSON.stringify({ notes: [{ id: '2rE7gVcPit', forum: '2rE7gVcPit',
					content: Object.fromEntries(Object.entries({ title: publishedTitle, authors,
						venue: 'CAO Poster', venueid: 'ICLR.cc/2026/Workshop/CAO' }).map(([key, value]) => [key, { value }])) }] });
			}
			else {
				status = 404; body = '{}';
			}
			return { status, response: new TextEncoder().encode(body).buffer,
				getResponseHeader: () => (url.includes('arxiv') ? 'application/atom+xml' : 'application/json') };
		});
		collection = await createDataObject('collection');
		parent = await createDataObject('item', { itemType: 'preprint', title,
			collections: [collection.id], tags: [{ tag: 'Personal tag' }] });
		parent.setField('archiveID', '2602.21307');
		parent.setField('DOI', '10.48550/arxiv.2602.21307');
		parent.setField('citationKey', 'Tan2026SymTorch');
		parent.setField('extra', 'Personal notes');
		parent.setCreators(authors.map(name => ({ creatorType: 'author', name })));
		await parent.saveTx();
		attachment = await importPDFAttachment(parent);
		annotation = await createAnnotation('highlight', attachment);
	});

	afterEach(async function () {
		await client?.close();
		sandbox.restore();
		if (parent) await parent.eraseTx();
		if (collection) await collection.eraseTx();
		for (let [name, value] of saved) {
			if (value === undefined) Zotero.Prefs.clear(name);
			else Zotero.Prefs.set(name, value);
		}
		for (let suffix of ['', '-wal', '-shm']) await IOUtils.remove(cachePath + suffix, { ignoreAbsent: true });
	});

	/** Exercise the exact UI query shape before opening a modal, avoiding a hung window wait on failure. */
	async function expectVariant() {
		let result = await Zotero.RecognizeDocument.queryPDFMetadata({ metadata: {
			arxiv: '2602.21307', Title: title, Author: authors.join('; ')
		}, pages: [], totalPages: 0, includeAlternatives: true });
		assert.equal(result.status, 'needs_review');
		assert.isTrue(result.candidates.some(c => c.item.title == publishedTitle));
		let source = result.review.sources.find(s => s.item.title == publishedTitle);
		assert.isOk(source);
		assert.deepEqual(source.mergeFields, []);
		assert.equal(result.review.custom.item.itemType, 'preprint');
	}

	it('continues explicit publication review after a shared preprint hit and its cached copy', async function () {
		// Stub only the shared HTTP boundary, leaving the worker's repository
		// orchestration and native account-scoped SQLite storage operational.
		sandbox.stub(client, '_repositoryConfiguration').returns({
			base: 'https://metadata.example.test/', contribute: false
		});
		let query = sandbox.stub(client, '_requestRepository').resolves({ schema: 1, records: [{
			id: 'a'.repeat(64), expiresAt: Date.now() + 60000, source: 'arXiv',
			item: { itemType: 'preprint', title, archiveID: '2602.21307', repository: 'arXiv',
				url: 'https://arxiv.org/abs/2602.21307', libraryCatalog: 'arXiv',
				creators: authors.map(name => ({ name, creatorType: 'author' })) }
		}] });
		await expectVariant();
		await expectVariant();
		assert.equal(query.callCount, 1, 'The second lookup must exercise the shared SQLite cache');
		assert.equal(parent.getField('title'), title);
		assert.equal(parent.itemTypeID, Zotero.ItemTypes.getID('preprint'));
	});

	it('offers the changed title in the native dialog and cancellation preserves the full item tree', async function () {
		await expectVariant();
		const before = [parent, attachment, annotation].map(item => item.toJSON());
		let opened = waitForWindow('chrome://zotero/content/recognitionReview.xhtml', (dialog) => {
			try {
				let review = dialog.Zotero_Recognition_Review;
				assert.isTrue(review.review.sources.some(s => s.item.title == publishedTitle));
				assert.equal(review.selectedItem().title, publishedTitle);
				assert.isFalse(review.dialog.getButton('accept').disabled);
				assert.isTrue(dialog.document.getElementById('recognition-review-warning').hidden);
				assert.isNull(review.io.out, 'Showing the eligible publication does not apply it');
				let select = dialog.document.getElementById('recognition-review-sources');
				select.value = 'custom';
				select.dispatchEvent(new dialog.Event('change'));
				assert.isTrue(review.dialog.getButton('accept').disabled,
					'The original preprint/Custom option cannot authorize a publication upgrade');
				assert.equal(dialog.document.getElementById('recognition-review-warning').textContent,
					'This source is a preprint, not a published record.');
				assert.isFalse(review.accept());
				assert.equal(parent.getField('title'), title);
			}
			finally {
				dialog.close();
			}
		});
		assert.isFalse(await Zotero.RecognizeDocument.refreshPublishedMetadata(parent));
		await opened;
		assert.deepEqual([parent, attachment, annotation].map(item => item.toJSON()), before);
	});

	it('confirming the initially displayed publication updates it in place after reopening the SQLite cache', async function () {
		await expectVariant();
		await client.close();
		client = new Zotero.LocalRecognitionClient({ cachePath });
		await expectVariant();
		const key = parent.key, before = [attachment, annotation].map(item => item.toJSON());
		let opened = waitForWindow('chrome://zotero/content/recognitionReview.xhtml', (dialog) => {
			try {
				let review = dialog.Zotero_Recognition_Review;
				let source = review.review.sources.find(s => s.item.title == publishedTitle);
				let select = dialog.document.getElementById('recognition-review-sources');
				assert.equal(select.value, source.id);
				assert.isTrue(dialog.document.getElementById('recognition-review-warning').hidden);
				assert.isNull(review.io.out);
				assert.include(dialog.document.getElementById('recognition-review-fields').textContent, 'CAO');
				assert.isFalse(review.dialog.getButton('accept').disabled);
				assert.equal(parent.getField('title'), title, 'Browsing must not change the live item');
				review.dialog.acceptDialog();
			}
			catch (error) {
				dialog.close(); throw error;
			}
		});
		assert.isTrue(await Zotero.RecognizeDocument.refreshPublishedMetadata(parent));
		await opened;
		assert.equal(parent.key, key);
		assert.equal(parent.getField('title'), publishedTitle);
		assert.equal(parent.itemTypeID, Zotero.ItemTypes.getID('conferencePaper'));
		assert.equal(parent.getField('proceedingsTitle'), 'CAO');
		assert.equal(parent.getField('citationKey'), 'Tan2026SymTorch');
		assert.deepEqual(parent.getCollections(), [collection.id]);
		assert.deepEqual(parent.getTags(), [{ tag: 'Personal tag' }]);
		assert.include(parent.getField('extra'), 'Personal notes');
		assert.include(parent.getField('extra'), 'Preprint DOI: 10.48550/arxiv.2602.21307');
		assert.deepEqual([attachment, annotation].map(item => item.toJSON()), before);
	});
});
