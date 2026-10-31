/* global describe, beforeEach, afterEach, it, assert, sinon, createDataObject,
 importPDFAttachment, createAnnotation, waitForWindow */
"use strict";

/**
 * Reproduce the non-reciprocal/nonreciprocal publication failure through the
 * shipped worker, native SQLite, desktop validation, modal and item transaction.
 * Only catalog HTTP is substituted. All library objects belong to the test
 * profile; no user's collection, credentials or remote server is accessed.
 */
describe('Publication compound spelling review', function () {
	this.timeout(60000);
	const title = 'Interpreting neural operators: how nonlinear waves propagate in non-reciprocal solids';
	const publishedTitle = 'Interpreting Neural Operators: How Nonlinear Waves Propagate in Nonreciprocal Solids';
	const authors = ['Jonathan Colen', 'Alexis Poncet', 'Denis Bartolo', 'Vincenzo Vitelli'];
	const doi = '10.1103/physrevlett.133.107301';
	const names = ['recognize.engine', 'recognize.repository.enabled'];
	let sandbox, saved, client, cachePath, parent, collection, attachment, annotation, catalogTitle;

	beforeEach(async function () {
		sandbox = sinon.createSandbox();
		saved = names.map(name => [name, Zotero.Prefs.get(name)]);
		Zotero.Prefs.set('recognize.engine', 'epilib-local');
		Zotero.Prefs.set('recognize.repository.enabled', false);
		cachePath = PathUtils.join(PathUtils.tempDir, 'epilib-compound-' + Zotero.Utilities.randomString() + '.sqlite');
		client = new Zotero.LocalRecognitionClient({ cachePath });
		sandbox.stub(Zotero.LocalRecognition, 'recognize').callsFake((...args) => client.recognize(...args));
		sandbox.stub(Zotero.RecognizeDocument, 'getProviderCredentials').resolves({});
		catalogTitle = publishedTitle;
		// The public bibliographic fields mirror arXiv:2404.12918 and Crossref's
		// PRL deposit. Keeping raw provider shapes exercises both real adapters.
		sandbox.stub(Zotero.HTTP, 'request').callsFake(async (method, url) => {
			let status = 200, body;
			if (url.startsWith('https://export.arxiv.org/')) {
				body = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
					<id>https://arxiv.org/abs/2404.12918v1</id><title>${title}</title>
					<published>2024-04-19T14:42:42Z</published>
					${authors.map(name => `<author><name>${name}</name></author>`).join('')}</entry></feed>`;
			}
			else if (url.startsWith('https://api.crossref.org/works?')) {
				body = JSON.stringify({ message: { items: [{ type: 'journal-article', title: [catalogTitle], DOI: doi,
					author: authors.map(name => ({ given: name.split(' ')[0], family: name.split(' ')[1] })),
					'container-title': ['Physical Review Letters'], volume: '133', issue: '10',
					'article-number': '107301', published: { 'date-parts': [[2024, 9, 3]] } }] } });
			}
			else if (/^https:\/\/api2?\.openreview\.net\//.test(url)) body = JSON.stringify({ notes: [] });
			else {
				status = 404;
				body = '{}';
			}
			return { status, response: new TextEncoder().encode(body).buffer,
				getResponseHeader: () => (url.includes('arxiv') ? 'application/atom+xml' : 'application/json') };
		});
		collection = await createDataObject('collection');
		parent = await createDataObject('item', { itemType: 'preprint', title,
			collections: [collection.id], tags: [{ tag: 'Keep this tag' }] });
		parent.setField('archiveID', '2404.12918');
		parent.setField('DOI', '10.48550/arxiv.2404.12918');
		parent.setField('citationKey', 'Colen2024Interpreting');
		parent.setField('extra', 'Keep these personal notes');
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

	/** Fail before waiting on a modal if the worker still rejects the publication. */
	async function expectPublication() {
		let result = await Zotero.RecognizeDocument.queryPDFMetadata({ metadata: {
			arxiv: '2404.12918', Title: title, Author: authors.join('; ')
		}, pages: [], totalPages: 0, includeAlternatives: true });
		assert.equal(result.status, 'needs_review');
		let candidate = result.candidates.find(c => c.item.DOI == doi);
		assert.isOk(candidate);
		assert.isTrue(candidate.evidence.titleVariant);
		assert.deepEqual(result.review.sources.find(s => s.item.DOI == doi).mergeFields, []);
		assert.equal(result.review.custom.item.itemType, 'preprint');
	}

	it('shows the journal with an enabled accept button and cancellation leaves the item tree unchanged', async function () {
		await expectPublication();
		const before = [parent, attachment, annotation].map(item => item.toJSON());
		let opened = waitForWindow('chrome://zotero/content/recognitionReview.xhtml', (dialog) => {
			try {
				let review = dialog.Zotero_Recognition_Review;
				assert.equal(review.selectedItem().DOI, doi);
				assert.isFalse(review.dialog.getButton('accept').disabled);
				assert.isTrue(dialog.document.getElementById('recognition-review-warning').hidden);
				assert.isNull(review.io.out, 'Displaying the journal is not authorization to apply it');
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

	it('upgrades in place only after confirmation, including after reopening the warm SQLite cache', async function () {
		await expectPublication();
		await client.close();
		client = new Zotero.LocalRecognitionClient({ cachePath });
		await expectPublication();
		const key = parent.key, id = parent.id;
		const children = [attachment, annotation].map(item => item.toJSON());
		let opened = waitForWindow('chrome://zotero/content/recognitionReview.xhtml', (dialog) => {
			try {
				let review = dialog.Zotero_Recognition_Review;
				assert.equal(review.selectedItem().DOI, doi);
				assert.isNull(review.io.out);
				assert.isTrue(dialog.document.getElementById('recognition-review-warning').hidden);
				assert.include(dialog.document.getElementById('recognition-review-fields').textContent, 'Physical Review Letters');
				review.dialog.acceptDialog();
			}
			catch (error) {
				dialog.close();
				throw error;
			}
		});
		assert.isTrue(await Zotero.RecognizeDocument.refreshPublishedMetadata(parent));
		await opened;
		assert.equal(parent.id, id);
		assert.equal(parent.key, key);
		assert.equal(parent.getField('title'), publishedTitle);
		assert.equal(parent.itemTypeID, Zotero.ItemTypes.getID('journalArticle'));
		assert.equal(parent.getField('DOI'), doi);
		assert.equal(parent.getField('publicationTitle'), 'Physical Review Letters');
		assert.equal(parent.getField('volume'), '133');
		assert.equal(parent.getField('issue'), '10');
		assert.equal(parent.getField('pages'), '107301');
		assert.equal(parent.getField('citationKey'), 'Colen2024Interpreting');
		assert.deepEqual(parent.getCollections(), [collection.id]);
		assert.deepEqual(parent.getTags(), [{ tag: 'Keep this tag' }]);
		assert.include(parent.getField('extra'), 'Keep these personal notes');
		assert.include(parent.getField('extra'), 'Preprint DOI: 10.48550/arxiv.2404.12918');
		assert.deepEqual([attachment, annotation].map(item => item.toJSON()), children);
	});

	it('refuses a real negation change without modifying the preprint or its PDF', async function () {
		catalogTitle = publishedTitle.replace('Nonreciprocal', 'Reciprocal');
		const before = [parent, attachment, annotation].map(item => item.toJSON());
		try {
			await Zotero.RecognizeDocument.refreshPublishedMetadata(parent);
			assert.fail('A different physical claim must not be accepted as this publication');
		}
		catch (error) {
			assert.equal(error.message, Zotero.getString('recognition-refresh-no-publication'));
		}
		assert.deepEqual([parent, attachment, annotation].map(item => item.toJSON()), before);
	});
});
