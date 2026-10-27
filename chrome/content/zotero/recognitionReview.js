// The XUL onload handler and dialog callers access this window-global controller.
// eslint-disable-next-line no-unused-vars
var Zotero_Recognition_Review = {

	/** Bind a modal snapshot; all edits remain in memory until explicit acceptance. */
	init() {
		this.io = window.arguments[0].wrappedJSObject || window.arguments[0];
		this.review = this.io.review;
		this.custom = JSON.parse(JSON.stringify(this.review.custom.item));
		this.fieldSources = { ...this.review.custom.fieldSources };
		this.dialog = document.getElementById('recognition-review-dialog');
		document.title = Zotero.getString('recognition-review-title');
		this.dialog.getButton('accept').label = Zotero.getString('recognition-review-use');
		this.dialog.getButton('cancel').label = Zotero.getString('recognition-review-cancel');
		for (let [id, key] of Object.entries({ 'sources-label': 'sources', 'field-header': 'field',
			'value-header': 'value', 'source-header': 'source', 'replace-label': 'replace' })) {
			document.getElementById('recognition-review-' + id).textContent = Zotero.getString('recognition-review-' + key);
		}
		let select = document.getElementById('recognition-review-sources');
		select.appendChild(this.element('option', Zotero.getString('recognition-review-custom'), { value: 'custom' }));
		for (let source of this.review.sources) {
			let type = Zotero.ItemTypes.getLocalizedString(source.item.itemType);
			let label = source.id == 'recognized' ? this.sourceLabel(source) : `${this.sourceLabel(source)} (${type})`;
			select.appendChild(this.element('option', label, { value: source.id, title: `${type}: ${source.item.title}` }));
		}
		select.value = this.initialSourceID();
		select.addEventListener('change', () => this.render());
		document.getElementById('recognition-review-replace-row').hidden = !this.io.refresh;
		let status = document.getElementById('recognition-review-provider-status');
		for (let provider of this.review.providers) {
			status.appendChild(this.element('p', provider.name + ': '
				+ Zotero.getString('recognition-review-status-' + provider.status)));
		}
		document.addEventListener('dialogaccept', (event) => {
			if (!this.accept()) event.preventDefault();
		});
		this.render();
		select.focus();
	},

	/** Create HTML in this mixed XUL/HTML dialog, using textContent rather than markup. */
	element(tag, value = '', attributes = {}) {
		let node = document.createElementNS('http://www.w3.org/1999/xhtml', tag);
		node.textContent = value;
		for (let [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
		return node;
	},

	/** The recognized fallback may already combine providers; never label it a raw source. */
	sourceLabel(source) {
		return source.id == 'recognized' ? Zotero.getString('recognition-review-result') : source.label;
	},

	/**
	 * Choose the first record to DISPLAY, not a record to apply to the library.
	 *
	 * The recognition engine intentionally keeps Custom based on the preprint
	 * when a differently titled publication needs manual review. Always opening
	 * on Custom would therefore show a rejection warning and a disabled button
	 * even though a usable publication is present in the source list.
	 *
	 * Prefer Custom when it satisfies this action's existing type/DOI rules;
	 * otherwise display the first source that satisfies those same rules. Do not
	 * rebuild Custom, merge versions, relax canAccept(), or set io.out here.
	 * The user must still confirm with Use This Record. If nothing is eligible,
	 * leave Custom inspectable and let render()/accept() keep saving blocked.
	 *
	 * @returns {string} Source-list option ID to show when the dialog opens.
	 */
	initialSourceID() {
		if (this.canAccept(this.custom)) return 'custom';
		return this.review.sources.find(source => this.canAccept(source.item))?.id || 'custom';
	},

	/** Read selection without mutating the source records or caller's live library item. */
	selectedItem() {
		let id = document.getElementById('recognition-review-sources').value;
		return id == 'custom' ? this.custom : this.review.sources.find(source => source.id == id)?.item;
	},

	/** Existing-publication refresh cannot silently change DOI/type to a repository version. */
	canAccept(item) {
		return !!item && (!this.io.allowedTypes || this.io.allowedTypes.includes(item.itemType))
			&& (!this.io.requiredDOI || item.DOI?.toLowerCase() == this.io.requiredDOI.toLowerCase());
	},

	/** Render complete bylines and tags as readable text while preserving their data arrays. */
	format(field, value) {
		if (field == 'itemType') return Zotero.ItemTypes.getLocalizedString(value);
		if (field == 'creators') return value.map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).join('\n');
		if (field == 'tags') return value.map(t => t.tag).join(', ');
		return typeof value == 'string' ? value : '';
	},

	/** Localize schema fields using the same names as the main item pane. */
	fieldLabel(field) {
		if (['itemType', 'creators', 'tags'].includes(field)) return Zotero.getString('recognition-review-' + field);
		return Zotero.ItemFields.getLocalizedString(field);
	},

	/**
	 * Collect distinct, permitted values for a Custom field. Sources agreeing on a
	 * value share one choice. Incompatible versions cannot offer a date/venue/DOI.
	 * Include the current combined value so changing another field is never lossy.
	 */
	choices(field) {
		let choices = [];
		for (let source of this.review.sources) {
			let value = source.item[field];
			if (!source.mergeFields.includes(field) || !value || (Array.isArray(value) && !value.length)) continue;
			let existing = choices.find(choice => JSON.stringify(choice.value) == JSON.stringify(value));
			if (existing) existing.labels.push(this.sourceLabel(source));
			else choices.push({ value, id: source.id, labels: [this.sourceLabel(source)] });
		}
		let value = this.custom[field];
		if (value && !choices.some(choice => JSON.stringify(choice.value) == JSON.stringify(value))) {
			choices.unshift({ value, id: this.fieldSources[field] || 'recognized',
				labels: [Zotero.getString('recognition-review-result')] });
		}
		return choices;
	},

	/**
	 * Rebuild the detail table when switching source; controls change Custom only.
	 * Field rows use fixed column tracks and wrap long abstracts/URLs. Provider
	 * values are never HTML, even when a remote title contains markup characters.
	 */
	render() {
		let item = this.selectedItem();
		if (!item) return;
		let custom = document.getElementById('recognition-review-sources').value == 'custom';
		document.getElementById('recognition-review-heading').textContent = item.title;
		document.getElementById('recognition-review-summary').textContent = [
			Zotero.ItemTypes.getLocalizedString(item.itemType), item.date, item.DOI || item.ISBN || item.archiveID
		].filter(Boolean).join(' | ');
		let allowed = this.canAccept(item);
		this.dialog.getButton('accept').disabled = !allowed;
		let warning = document.getElementById('recognition-review-warning');
		warning.hidden = allowed;
		// A preprint remains useful for comparison but is not a published upgrade.
		// Explain that specific restriction instead of implying the publication
		// lookup failed. Other type/DOI conflicts retain the existing warning.
		let preprintBlocked = item.itemType == 'preprint' && this.io.allowedTypes
			&& !this.io.allowedTypes.includes('preprint');
		warning.textContent = allowed
			? ''
			: Zotero.getString(preprintBlocked
				? 'recognition-review-preprint-not-publication'
				: 'recognition-review-different-version');
		let body = document.getElementById('recognition-review-fields');
		body.replaceChildren();
		let fields = ['itemType', 'title', 'creators', ...Zotero.ItemFields.getItemTypeFields(Zotero.ItemTypes.getID(item.itemType))
			.map(id => Zotero.ItemFields.getName(id)), 'tags'];
		for (let field of [...new Set(fields)]) {
			// Citation keys are generated locally on save, not sourced from a provider.
			if (field == 'citationKey' || !item[field] || (Array.isArray(item[field]) && !item[field].length)) continue;
			let row = this.element('tr', '', { 'data-field': field });
			row.appendChild(this.element('th', this.fieldLabel(field), { scope: 'row' }));
			row.appendChild(this.element('td', this.format(field, item[field]), { class: 'metadata-value' }));
			let sourceCell = this.element('td');
			let choices = custom ? this.choices(field) : [];
			if (choices.length > 1) {
				let select = this.element('select', '', { 'aria-label': this.fieldLabel(field) + ': '
					+ Zotero.getString('recognition-review-source'), class: 'metadata-source-choice' });
				for (let [i, choice] of choices.entries()) {
					select.appendChild(this.element('option', choice.labels.join(' / '), { value: i,
						title: this.format(field, choice.value) }));
				}
				select.value = choices.findIndex(choice => JSON.stringify(choice.value) == JSON.stringify(item[field]));
				select.addEventListener('change', () => {
					let choice = choices[Number(select.value)];
					this.custom[field] = JSON.parse(JSON.stringify(choice.value));
					this.fieldSources[field] = choice.id;
					row.querySelector('.metadata-value').textContent = this.format(field, choice.value);
				});
				sourceCell.appendChild(select);
			}
			else {
				let id = custom ? this.fieldSources[field] : document.getElementById('recognition-review-sources').value;
				let source = this.review.sources.find(s => s.id == id);
				sourceCell.textContent = source ? this.sourceLabel(source) : '';
			}
			row.appendChild(sourceCell);
			body.appendChild(row);
		}
	},

	/** Commit a detached bibliographic record; Cancel/window-close leaves io.out null. */
	accept() {
		let item = this.selectedItem();
		if (!this.canAccept(item)) return false;
		this.io.out = JSON.parse(JSON.stringify(item));
		this.io.replaceExisting = !!this.io.refresh && document.getElementById('recognition-review-replace').checked;
		return true;
	}
};
