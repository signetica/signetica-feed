'use strict';
'require view';
'require uci';
'require ui';
'require fs';

/*
 * Build a lookup table mapping tc class IDs (e.g. "20") to UCI device names.
 * Class IDs in tc output are "1:20"; we match against the numeric suffix.
 */
function buildNameMap() {
	var map = {};
	var sections = uci.sections('regulatrix', 'device');
	for (var i = 0; i < sections.length; i++) {
		var s = sections[i];
		if (s.id && s.device_name)
			map[String(s.id)] = s.device_name;
	}
	return map;
}

/*
 * Look up the device name for a tc classid like "1:20".
 * Returns the name or "—" for internal classes (root 1:1, default 1:10).
 */
function classidToName(classid, nameMap) {
	if (!classid)
		return '—';
	var parts = classid.split(':');
	var id = parts.length > 1 ? parts[1] : parts[0];

	if (id === '1')
		return _('(root)');
	if (id === '10')
		return _('(default)');

	return nameMap[id] || '—';
}

/*
 * Parse the output of `tc -s class show dev $device` into an array of objects.
 * Each object: { classid, rate, ceil, actual_rate, sent_bytes,
 *                dropped, overlimits }
 *
 * The configured rate/ceil appear on the "class htb" definition line.
 * The estimated actual rate (enabled via htb_rate_est) appears on a
 * subsequent line matching: rate <value> <N>pps
 */
function parseTcStats(raw) {
	var classes = [];
	if (!raw)
		return classes;

	var blocks = raw.split(/(?=class htb)/);
	for (var i = 0; i < blocks.length; i++) {
		var block = blocks[i];
		if (!/^class htb/.test(block))
			continue;

		var m_class = block.match(/^class htb (\S+)/);
		var m_rate  = block.match(/\brate (\S+)/);
		var m_ceil  = block.match(/\bceil (\S+)/);
		var m_sent  = block.match(/Sent (\d+) bytes (\d+) pkt/);
		var m_drop  = block.match(/dropped (\d+)/);
		var m_over  = block.match(/overlimits (\d+)/);

		/* The rate estimate line appears after Sent, indented,
		 * with the format: rate <value> <N>pps */
		var m_est   = block.match(/\n\s+rate (\S+) \d+pps/);

		classes.push({
			classid:     m_class ? m_class[1] : '?',
			rate:        m_rate  ? m_rate[1]  : '—',
			ceil:        m_ceil  ? m_ceil[1]  : '—',
			actual_rate: m_est   ? m_est[1]   : '—',
			sent_bytes:  m_sent  ? +m_sent[1] : 0,
			dropped:     m_drop  ? +m_drop[1] : 0,
			overlimits:  m_over  ? +m_over[1] : 0
		});
	}
	return classes;
}

/*
 * Fetch tc stats for a device via LuCI.fs.
 */
function fetchDeviceStats(device) {
	if (!device)
		return Promise.resolve([]);
	return fs.exec_direct('/sbin/tc', ['-s', 'class', 'show', 'dev', device])
		.then(parseTcStats)
		.catch(function() { return []; });
}

/*
 * Format a byte count as a human-readable string.
 */
function humanBytes(bytes) {
	if (bytes >= 1073741824)
		return (bytes / 1073741824).toFixed(2) + ' GiB';
	if (bytes >= 1048576)
		return (bytes / 1048576).toFixed(2) + ' MiB';
	if (bytes >= 1024)
		return (bytes / 1024).toFixed(1) + ' KiB';
	return bytes + ' B';
}

/*
 * Render a stats table for one direction.
 */
function renderStatsTable(direction, device, classes, nameMap) {
	var title = direction.charAt(0).toUpperCase() + direction.slice(1);

	if (!device)
		return E('p', { 'class': 'cbi-value-description' },
			_('%s shaping is not enabled.').format(title));

	if (!classes || classes.length === 0)
		return E('p', { 'class': 'cbi-value-description' },
			_('No active %s classes. Is regulatrix running?').format(
				title.toLowerCase()));

	var rows = [
		E('tr', { 'class': 'tr cbi-section-table-titles' }, [
			E('th', { 'class': 'th' }, _('Name')),
			E('th', { 'class': 'th' }, _('Class')),
			E('th', { 'class': 'th' }, _('Rate')),
			E('th', { 'class': 'th' }, _('Ceiling')),
			E('th', { 'class': 'th' }, _('Actual')),
			E('th', { 'class': 'th' }, _('Sent')),
			E('th', { 'class': 'th' }, _('Dropped')),
			E('th', { 'class': 'th' }, _('Overlimits'))
		])
	];

	for (var i = 0; i < classes.length; i++) {
		var c = classes[i];
		rows.push(E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, classidToName(c.classid, nameMap)),
			E('td', { 'class': 'td' }, c.classid),
			E('td', { 'class': 'td' }, c.rate),
			E('td', { 'class': 'td' }, c.ceil),
			E('td', { 'class': 'td' }, c.actual_rate),
			E('td', { 'class': 'td' }, humanBytes(c.sent_bytes)),
			E('td', { 'class': 'td' }, String(c.dropped)),
			E('td', { 'class': 'td' }, String(c.overlimits))
		]));
	}

	return E('div', {}, [
		E('h4', {}, _('%s — %s').format(title, device)),
		E('table', { 'class': 'table cbi-section-table' }, rows)
	]);
}

/*
 * Fetch and render stats for both directions, replacing container contents.
 */
function refreshStats() {
	var container = document.getElementById('stats-content');
	if (!container)
		return Promise.resolve();

	var wan_dev = uci.get('regulatrix', '@global[0]', 'wan_dev');
	var lan_dev = uci.get('regulatrix', '@global[0]', 'lan_dev');
	var enable_out = uci.get('regulatrix', '@global[0]', 'enable_outbound_filter');
	var enable_in  = uci.get('regulatrix', '@global[0]', 'enable_inbound_filter');

	var ob_dev = (enable_out === '1') ? wan_dev : null;
	var ib_dev = (enable_in  === '1') ? lan_dev : null;

	var nameMap = buildNameMap();

	return Promise.all([
		fetchDeviceStats(ob_dev),
		fetchDeviceStats(ib_dev)
	]).then(function(results) {
		while (container.firstChild)
			container.removeChild(container.firstChild);
		container.appendChild(renderStatsTable('outbound', ob_dev, results[0], nameMap));
		container.appendChild(renderStatsTable('inbound',  ib_dev, results[1], nameMap));
	});
}

return view.extend({
	load: function() {
		return uci.load('regulatrix');
	},

	render: function() {
		var body = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Regulatrix — Traffic Statistics')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Live class counters from the active HTB qdiscs. ' +
				  'These reset when regulatrix is restarted.')),
			E('div', { 'id': 'stats-content' },
				E('p', { 'class': 'cbi-value-description' },
					_('Loading statistics…'))),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': function(ev) {
						var btn = ev.target;
						btn.classList.add('spinning');
						btn.disabled = true;
						refreshStats().finally(function() {
							btn.classList.remove('spinning');
							btn.disabled = false;
						});
					}
				}, _('Refresh Statistics'))
			])
		]);

		/* Load stats immediately after render. */
		requestAnimationFrame(function() {
			refreshStats();
		});

		return body;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
