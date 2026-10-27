/* global describe, it, afterEach, assert, waitForWindow */
describe('PDF metadata source comparison', function () {
	let win;
	const url = 'chrome://zotero/content/recognitionReview.xhtml';

	/** Minimal detached records model a publication and its earlier repository copy. */
	function fixture() {
		let item = { itemType: 'conferencePaper', title: 'A paper with a long and descriptive title for metadata comparison',
			DOI: '10.1234/paper', creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Example' }],
			date: '2024', proceedingsTitle: 'Example Conference', conferenceName: 'Conference 2024',
			eventPlace: 'Example City', libraryCatalog: 'Crossref' };
		let alternate = { ...item, date: '2024-03-01', pages: '1-12', libraryCatalog: 'DOI.org' };
		let repository = { itemType: 'preprint', title: item.title, creators: item.creators,
			date: '2023', archiveID: '2401.12345', abstractNote: 'A long abstract with bibliographic details. '.repeat(100), libraryCatalog: 'arXiv' };
		return { refresh: true, requiredDOI: item.DOI, allowedTypes: ['conferencePaper'], out: null,
			review: { sources: [
				{ id: 'recognized', label: 'Recognition result', item, mergeFields: [] },
				{ id: 'source-1', label: 'Crossref', item, mergeFields: ['date', 'creators'] },
				{ id: 'source-2', label: 'DOI.org', item: alternate, mergeFields: ['date', 'pages', 'creators'] },
				{ id: 'source-3', label: 'arXiv', item: repository, mergeFields: ['abstractNote', 'creators'] }
			], custom: { item: { ...item, pages: '1-12', abstractNote: repository.abstractNote, libraryCatalog: 'EpiLib (combined)' },
				fieldSources: { date: 'source-1', pages: 'source-2', abstractNote: 'source-3' } },
			providers: [{ name: 'Crossref', status: 'matched' },
				{ name: 'DataCite', status: 'no_match' },
				{ name: 'OpenReview', status: 'unavailable' }] } };
	}

	/** Open the real native dialog nonmodally so tests can operate its actual controls. */
	async function open(io) {
		let loaded = waitForWindow(url);
		win = window.openDialog(url, '', 'chrome,resizable', io);
		await loaded;
		await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
		return win.document;
	}

	afterEach(function () {
		if (win && !win.closed) win.close();
	});

	it('shows all sources, full metadata, labels and lookup outcomes with an aligned responsive table', async function () {
		let doc = await open(fixture());
		assert.equal(doc.getElementById('recognition-review-sources-label').textContent, 'Metadata sources');
		assert.equal(doc.getElementById('recognition-review-sources').options.length, 5);
		assert.equal(doc.getElementById('recognition-review-sources').value, 'custom');
		assert.include(doc.getElementById('recognition-review-fields').textContent, 'Example City');
		assert.include(doc.getElementById('recognition-review-fields').textContent, 'A long abstract');
		assert.include(doc.getElementById('recognition-review-provider-status').textContent, 'Lookup unavailable');
		assert.equal(doc.getElementById('recognition-review-value-header').textContent, 'Value');
		const reviewWindow = win;
		for (let width of [980, 720]) {
			win.resizeTo(width, 650);
			await new Promise(resolve => reviewWindow.requestAnimationFrame(() => reviewWindow.requestAnimationFrame(resolve)));
			let main = doc.getElementById('recognition-review-main').getBoundingClientRect();
			let sidebar = doc.getElementById('recognition-review-sidebar').getBoundingClientRect();
			assert.isAbove(main.left, sidebar.right);
			assert.isAtMost(main.right, win.innerWidth);
			let headers = doc.querySelectorAll('thead th');
			let cells = doc.querySelector('tbody tr').children;
			for (let i = 0; i < 3; i++) assert.closeTo(headers[i].getBoundingClientRect().left, cells[i].getBoundingClientRect().left, 1);
			let scroll = doc.getElementById('recognition-review-scroll');
			assert.isAtMost(scroll.getBoundingClientRect().bottom, win.innerHeight - 45);
			assert.isAbove(scroll.scrollHeight, scroll.clientHeight);
		}
		// Optional local QA artifact. Only synthetic fixture metadata is captured.
		let folder = Services.env.get('EPILIB_REVIEW_SCREENSHOTS');
		if (folder) {
			win.focus();
			await Zotero.Promise.delay(500);
			await win.promiseDocumentFlushed(() => {});
			let bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(
				new win.DOMRect(0, 0, win.innerWidth, win.innerHeight), 1,
				win.getComputedStyle(doc.documentElement).backgroundColor);
			let canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
			canvas.width = bitmap.width; canvas.height = bitmap.height;
			canvas.getContext('2d').drawImage(bitmap, 0, 0);
			let blob = await new Promise(resolve => canvas.toBlob(resolve));
			await IOUtils.makeDirectory(folder, { ignoreExisting: true });
			await IOUtils.write(PathUtils.join(folder, 'recognition-review.png'), new Uint8Array(await blob.arrayBuffer()));
			bitmap.close();
		}
	});

	it('labels an unconfigured catalog distinctly from a failed lookup', async function () {
		let io = fixture();
		io.review.providers.push({ name: 'Google Books', status: 'not_configured' });
		let doc = await open(io);
		assert.include(doc.getElementById('recognition-review-provider-status').textContent,
			'Google Books: API key not configured');
	});

	it('opens publication upgrades on an eligible source rather than an incompatible Custom preprint', async function () {
		// Reproduce the title-variant engine contract: Custom intentionally remains
		// the preprint, while a publication is offered only as a separate raw source.
		let io = fixture();
		let preprint = io.review.sources[3].item;
		io.requiredDOI = null;
		io.review.custom = { item: preprint, fieldSources: {} };
		io.review.sources[0].item = preprint;
		let snapshot = JSON.stringify(io.review);
		let doc = await open(io);
		let select = doc.getElementById('recognition-review-sources');
		let button = doc.getElementById('recognition-review-dialog').getButton('accept');
		let warning = doc.getElementById('recognition-review-warning');
		assert.equal(select.value, 'source-1');
		assert.isFalse(button.disabled);
		assert.isTrue(warning.hidden);
		assert.include(doc.getElementById('recognition-review-summary').textContent, 'Conference Paper');
		assert.isNull(io.out, 'Initial display is not consent to update the library');
		assert.equal(JSON.stringify(io.review), snapshot, 'Do not rebase or merge Custom onto the publication');

		// Selecting the original version explicitly still enforces the upgrade
		// restriction; the fix must not merely hide a warning or enable every row.
		for (let id of ['custom', 'recognized', 'source-3']) {
			select.value = id; select.dispatchEvent(new win.Event('change'));
			assert.isTrue(button.disabled);
			assert.isFalse(warning.hidden);
			assert.equal(warning.textContent, 'This source is a preprint, not a published record.');
			assert.isFalse(win.Zotero_Recognition_Review.accept());
			assert.isNull(io.out);
		}
		select.value = 'source-1'; select.dispatchEvent(new win.Event('change'));
		assert.isTrue(warning.hidden);
		assert.equal(warning.textContent, '');
		assert.isFalse(button.disabled);
		win.close();
		assert.isNull(io.out, 'Closing a preselected publication still cancels');
	});

	it('initial source selection obeys both item type and DOI restrictions during ordinary refresh', async function () {
		let io = fixture();
		io.review.custom.item.DOI = '10.1234/wrong-version';
		io.review.sources[0].item = { ...io.review.sources[0].item, DOI: '10.1234/wrong-version' };
		io.review.sources.unshift({ id: 'wrong-type', label: 'arXiv', mergeFields: [],
			item: { ...io.review.sources[3].item, DOI: io.requiredDOI } });
		let doc = await open(io);
		assert.equal(doc.getElementById('recognition-review-sources').value, 'source-1');
		assert.isTrue(doc.getElementById('recognition-review-warning').hidden);
		assert.isNull(io.out);
	});

	it('keeps an all-ineligible review inspectable but cannot accept any source', async function () {
		let io = fixture();
		io.requiredDOI = '10.1234/no-matching-source';
		let doc = await open(io);
		let select = doc.getElementById('recognition-review-sources');
		assert.equal(select.value, 'custom');
		assert.equal(select.options.length, 5);
		for (let option of select.options) {
			select.value = option.value; select.dispatchEvent(new win.Event('change'));
			assert.isTrue(doc.getElementById('recognition-review-dialog').getButton('accept').disabled);
			assert.isFalse(doc.getElementById('recognition-review-warning').hidden);
			assert.isFalse(win.Zotero_Recognition_Review.accept());
		}
		assert.isNull(io.out);
	});

	it('switches sources without losing custom choices or mutating raw records', async function () {
		let io = fixture(), snapshot = JSON.stringify(io.review);
		let doc = await open(io);
		let sources = doc.getElementById('recognition-review-sources');
		let date = doc.querySelector('[data-field="date"] select');
		assert.equal(date.options.length, 2); // arXiv's 2023 date is not a publication choice.
		date.value = '1'; date.dispatchEvent(new win.Event('change'));
		assert.equal(doc.querySelector('[data-field="date"] .metadata-value').textContent, '2024-03-01');
		sources.value = 'source-1'; sources.dispatchEvent(new win.Event('change'));
		assert.equal(doc.querySelector('[data-field="date"] .metadata-value').textContent, '2024');
		assert.isNull(doc.querySelector('.metadata-source-choice'));
		sources.value = 'custom'; sources.dispatchEvent(new win.Event('change'));
		assert.equal(doc.querySelector('[data-field="date"] .metadata-value').textContent, '2024-03-01');
		assert.equal(JSON.stringify(io.review), snapshot);
		assert.isFalse(doc.getElementById('recognition-review-replace').checked);
		doc.getElementById('recognition-review-replace').checked = true;
		doc.getElementById('recognition-review-dialog').acceptDialog();
		assert.equal(io.out.date, '2024-03-01');
		assert.equal(io.replaceExisting, true);
	});

	it('allows inspection but prevents applying another version during publication refresh', async function () {
		let io = fixture(), doc = await open(io);
		let sources = doc.getElementById('recognition-review-sources');
		sources.value = 'source-3'; sources.dispatchEvent(new win.Event('change'));
		assert.isTrue(doc.getElementById('recognition-review-dialog').getButton('accept').disabled);
		assert.isFalse(doc.getElementById('recognition-review-warning').hidden);
		assert.isFalse(win.Zotero_Recognition_Review.accept());
		assert.isNull(io.out);
	});

	it('new recognition can select a source directly and closing the window cancels', async function () {
		let io = fixture(); io.refresh = false; delete io.requiredDOI; delete io.allowedTypes;
		let doc = await open(io);
		assert.isTrue(doc.getElementById('recognition-review-replace-row').hidden);
		let sources = doc.getElementById('recognition-review-sources');
		sources.value = 'source-2'; sources.dispatchEvent(new win.Event('change'));
		doc.getElementById('recognition-review-dialog').acceptDialog();
		assert.equal(io.out.libraryCatalog, 'DOI.org');
		io = fixture(); await open(io); win.close();
		assert.isNull(io.out);
	});
});
