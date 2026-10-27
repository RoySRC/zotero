window.EpiLibUpdateWindow = {
	version: null,

	/** Background notifications reuse their result instead of fetching twice. */
	async init() {
		document.getElementById('epilib-update-auto').checked = Zotero.Prefs.get('epilib.updates.enabled');
		let args = window.arguments?.[0];
		let result = (args?.wrappedJSObject || args)?.result;
		if (result) this.showResult(result);
		else await this.refresh();
		if (!window.closed) {
			await document.l10n.translateRoots();
			if (!window.closed) window.sizeToContent();
		}
	},

	/** Never insert remote HTML into this privileged window. */
	status(id, args) {
		document.l10n.setAttributes(document.getElementById('epilib-update-status'), id, args);
	},

	/** Ignore late responses when the window was closed during the request. */
	async refresh() {
		let button = document.getElementById('epilib-update-check');
		button.disabled = true;
		this.version = null;
		this.status('epilib-updates-checking');
		try {
			let result = await Zotero.EpiLibUpdates.check();
			if (!window.closed) this.showResult(result);
		}
		catch (error) {
			Zotero.debug(`EpiLib update check failed: ${error.message}`, 2);
			if (!window.closed) this.status('epilib-updates-unavailable');
		}
		finally {
			if (!window.closed) button.disabled = false;
		}
	},

	/** Distinguish development builds, newer releases and already-current installs. */
	showResult(result) {
		this.version = result.version;
		let id = result.development
			? 'epilib-updates-development'
			: result.available ? 'epilib-updates-available' : 'epilib-updates-current';
		this.status(id, { version: result.version, current: result.currentVersion || '' });
	}
};
