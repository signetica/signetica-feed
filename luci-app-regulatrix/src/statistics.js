'use strict';
'require view';
'require uci';
'require ui';
'require fs';

/* ── Shared Utilities ──────────────────────────────────────────── */

/*
 * Format a byte count as a human-readable string.
 */
function humanBytes(bytes) {
	if (bytes >= 1000000000)
		return (bytes / 1000000000).toFixed(2) + ' GB';
	if (bytes >= 1000000)
		return (bytes / 1000000).toFixed(1) + ' MB';
	if (bytes >= 1000)
		return (bytes / 1000).toFixed(1) + ' KB';
	return bytes + ' B';
}

/*
 * Parse a tc rate string (e.g. "300Kbit", "1Mbit") into a numeric
 * value in bits for sorting purposes.
 */
function parseRate(rateStr) {
	if (!rateStr || rateStr === '—')
		return 0;
	var m = rateStr.match(/^(\d+(?:\.\d+)?)\s*(bit|[KMG]bit)/i);
	if (!m)
		return 0;
	var val = parseFloat(m[1]);
	var unit = m[2].charAt(0).toUpperCase();
	if (unit === 'K')
		return val * 1000;
	if (unit === 'M')
		return val * 1000000;
	if (unit === 'G')
		return val * 1000000000;
	return val;
}

/*
 * Build a sortable table.  Click a column header to sort ascending;
 * click again for descending.  An arrow indicator shows the active
 * sort direction.
 *
 *   columns:  [{ title: string, numeric: bool }]
 *   rowData:  [{ display: [string, …], sort: [value, …] }]
 *
 * display[] values become cell text; sort[] values drive comparisons
 * (use raw numbers for numeric columns so sorting is meaningful).
 */
function makeSortableTable(columns, rowData) {
	var state = { col: -1, asc: true };

	var headerCells = [];
	for (var ci = 0; ci < columns.length; ci++) {
		(function(idx) {
			var th = E('th', {
				'class': 'th',
				'style': 'cursor: pointer; user-select: none;'
			}, columns[idx].title + ' \u25bf');
			th.addEventListener('click', function() { sortByColumn(idx); });
			headerCells.push(th);
		})(ci);
	}

	var headerRow = E('tr', { 'class': 'tr cbi-section-table-titles' },
		headerCells);

	var dataRows = [];
	for (var ri = 0; ri < rowData.length; ri++) {
		var cells = [];
		for (var ci = 0; ci < rowData[ri].display.length; ci++)
			cells.push(E('td', { 'class': 'td' }, rowData[ri].display[ci]));
		dataRows.push(E('tr', { 'class': 'tr' }, cells));
	}

	var table = E('table', { 'class': 'table cbi-section-table' }, [headerRow]);
	for (var ri = 0; ri < dataRows.length; ri++)
		table.appendChild(dataRows[ri]);

	function sortByColumn(colIdx) {
		if (state.col === colIdx)
			state.asc = !state.asc;
		else {
			state.col = colIdx;
			state.asc = true;
		}

		/* Update header indicators. */
		for (var i = 0; i < headerCells.length; i++) {
			var arrow = (i === colIdx)
				? (state.asc ? ' \u25b4' : ' \u25be')
				: ' \u25bf';
			headerCells[i].textContent = columns[i].title + arrow;
		}

		/* Build an index array and sort it. */
		var indices = [];
		for (var i = 0; i < rowData.length; i++)
			indices.push(i);

		var numeric = columns[colIdx].numeric;
		indices.sort(function(a, b) {
			var va = rowData[a].sort[colIdx];
			var vb = rowData[b].sort[colIdx];
			var cmp = numeric
				? (va - vb)
				: String(va).localeCompare(String(vb));
			return state.asc ? cmp : -cmp;
		});

		/* Re-append rows in sorted order. */
		for (var i = 0; i < indices.length; i++)
			table.appendChild(dataRows[indices[i]]);
	}

	return table;
}

/* ── Rate Shaping Statistics ───────────────────────────────────── */

/*
 * Build a lookup table mapping tc class IDs (e.g. "20") to UCI device names.
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
 * Parse `tc -s class show dev $device` into an array of objects.
 * Captures both 1:* (rate shaping) and 2:* (quota subtree) classes.
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
function fetchTcStats(device) {
	if (!device)
		return Promise.resolve([]);
	return fs.exec_direct('/sbin/tc', ['-s', 'class', 'show', 'dev', device])
		.then(parseTcStats)
		.catch(function() { return []; });
}

/*
 * Build a lookup table from tc classid to class object for quick access.
 */
function buildTcMap(classes) {
	var map = {};
	for (var i = 0; i < classes.length; i++)
		map[classes[i].classid] = classes[i];
	return map;
}

/*
 * Render the rate shaping stats table for one direction.
 * Only shows 1:* classes (the rate shaping level).
 */
function renderShapingTable(direction, device, classes, nameMap) {
	var title = direction.charAt(0).toUpperCase() + direction.slice(1);

	if (!device)
		return E('p', { 'class': 'cbi-value-description' },
			_('%s shaping is not enabled.').format(title));

	/* Filter to only 1:* classes. */
	var shaping = [];
	for (var i = 0; i < classes.length; i++) {
		if (/^1:/.test(classes[i].classid))
			shaping.push(classes[i]);
	}

	if (shaping.length === 0)
		return E('p', { 'class': 'cbi-value-description' },
			_('No active %s classes. Is regulatrix running?').format(
				title.toLowerCase()));

	var columns = [
		{ title: _('Name'),       numeric: false },
		{ title: _('Class'),      numeric: false },
		{ title: _('Rate'),       numeric: true  },
		{ title: _('Ceiling'),    numeric: true  },
		{ title: _('Actual'),     numeric: true  },
		{ title: _('Sent'),       numeric: true  },
		{ title: _('Dropped'),    numeric: true  },
		{ title: _('Overlimits'), numeric: true  }
	];

	var rowData = [];
	for (var i = 0; i < shaping.length; i++) {
		var c = shaping[i];
		var name = classidToName(c.classid, nameMap);
		rowData.push({
			display: [
				name,
				c.classid,
				c.rate,
				c.ceil,
				c.actual_rate,
				humanBytes(c.sent_bytes),
				String(c.dropped),
				String(c.overlimits)
			],
			sort: [
				name,
				c.classid,
				parseRate(c.rate),
				parseRate(c.ceil),
				parseRate(c.actual_rate),
				c.sent_bytes,
				c.dropped,
				c.overlimits
			]
		});
	}

	return E('div', {}, [
		E('h4', {}, _('%s — %s').format(title, device)),
		makeSortableTable(columns, rowData)
	]);
}

/* ── Quota Statistics ──────────────────────────────────────────── */

/*
 * Parse `iptables -v -x -t mangle -L POSTROUTING` output into per-host
 * quota state.  Rules come in groups of three per host:
 *   Rule 3 (unconditional): floor tier mark — total traffic
 *   Rule 2 (quota2 gated):  T2 mark — traffic while T2 quota active
 *   Rule 1 (quota2 gated):  T1 mark — traffic while T1 quota active
 *
 * Returns an array of:
 *   { name, ip_octet, sent_bytes }
 *
 * Tier detection is handled by the caller using the configured quota
 * thresholds, which is more reliable than comparing per-rule byte
 * counts that may be inconsistent during a restart.
 */
function parseQuotaStats(raw) {
	if (!raw)
		return [];

	var hosts = [];
	var rules = [];
	var lines = raw.split('\n');

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf('regulatrix') === -1)
			continue;

		/* Parse fields from the iptables -v -x line.
		 * Format: pkts bytes MARK all -- in out source destination ...
		 * With -x, pkts and bytes are exact integers. */
		var m = line.match(
			/^\s*(\d+)\s+(\d+)\s+MARK\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\/\*/);
		if (!m)
			continue;

		/* Extract the mark value from the end of the line. */
		var m_mark = line.match(/MARK set (0x[0-9a-fA-F]+)/);

		rules.push({
			pkts:  +m[1],
			bytes: +m[2],
			dest:  m[3],
			mark:  m_mark ? parseInt(m_mark[1], 16) : 0
		});
	}

	/* Group every three consecutive rules into one host entry.
	 * Order: Rule 3 (unconditional), Rule 2 (T2 gated), Rule 1 (T1 gated).
	 * We only need the unconditional rule for total byte count. */
	for (var i = 0; i + 2 < rules.length; i += 3) {
		var r3 = rules[i];      /* Unconditional — total traffic */

		/* Recover IP octet from the mark.  Mark format is ${ip}00N decimal,
		 * so integer division by 1000 gives the last octet. */
		var ip_octet = Math.floor(r3.mark / 1000);

		hosts.push({
			name:      r3.dest,
			ip_octet:  ip_octet,
			sent_bytes: r3.bytes
		});
	}

	return hosts;
}

/*
 * Render the quota statistics table.
 * Correlates iptables quota data with tc stats from the 2:* subtree.
 */
function renderQuotaTable(quotaHosts, tcMap) {
	if (!quotaHosts || quotaHosts.length === 0)
		return E('p', { 'class': 'cbi-value-description' },
			_('No active quota rules found. Are quotas enabled and regulatrix running?'));

	/* Read quota config for tier limits and ceilings. */
	var quotas = uci.sections('regulatrix', 'quotas');
	var t1_quota = 0, t2_quota = 0;
	var t1_ceil = '—', t2_ceil = '—', t3_ceil = '—';

	if (quotas.length > 0) {
		var q = quotas[0];
		t1_quota = parseInt(q.t1_quota) || 0;
		t2_quota = parseInt(q.t2_quota) || 0;
		t1_ceil = q.t1_rate || '—';
		t2_ceil = q.t2_rate || '—';
		t3_ceil = q.t3_rate || '—';
	}

	var columns = [
		{ title: _('Name / IP'),   numeric: false },
		{ title: _('Sent'),        numeric: true  },
		{ title: _('Tier'),        numeric: true  },
		{ title: _('Tier Limit'),  numeric: true  },
		{ title: _('Ceiling'),     numeric: true  },
		{ title: _('Actual'),      numeric: true  },
		{ title: _('Dropped'),     numeric: true  },
		{ title: _('Overlimits'),  numeric: true  }
	];

	var rowData = [];
	for (var i = 0; i < quotaHosts.length; i++) {
		var h = quotaHosts[i];

		/* Determine tier from total bytes vs configured thresholds.
		 * This is more reliable than comparing per-rule byte counts,
		 * which can be inconsistent during a restart. */
		var tier;
		if (h.sent_bytes >= t2_quota && t2_quota > 0)
			tier = 3;
		else if (h.sent_bytes >= t1_quota && t1_quota > 0)
			tier = 2;
		else
			tier = 1;

		/* Tier limit and ceiling for the active tier. */
		var tierLimit, tierLimitRaw, ceiling, ceilingRaw;
		switch (tier) {
			case 1:
				tierLimitRaw = t1_quota;
				tierLimit = humanBytes(t1_quota);
				ceiling = t1_ceil;
				break;
			case 2:
				tierLimitRaw = t2_quota;
				tierLimit = humanBytes(t2_quota);
				ceiling = t2_ceil;
				break;
			default:
				tierLimitRaw = 0;
				tierLimit = '—';
				ceiling = t3_ceil;
		}
		ceilingRaw = parseRate(ceiling);

		/* Look up tc stats for the active class in the 2:* subtree.
		 * Classid format: 2:${ip_octet}${tier} */
		var tcClassId = '2:' + h.ip_octet + tier;
		var tc = tcMap[tcClassId];
		var actual   = tc ? tc.actual_rate        : '—';
		var dropped  = tc ? String(tc.dropped)    : '—';
		var overlim  = tc ? String(tc.overlimits) : '—';

		rowData.push({
			display: [
				h.name,
				humanBytes(h.sent_bytes),
				String(tier),
				tierLimit,
				ceiling,
				actual,
				dropped,
				overlim
			],
			sort: [
				h.name,
				h.sent_bytes,
				tier,
				tierLimitRaw,
				ceilingRaw,
				parseRate(actual),
				tc ? tc.dropped    : 0,
				tc ? tc.overlimits : 0
			]
		});
	}

	return E('div', {}, [
		E('h4', {}, _('Quota-Based Shaping')),
		makeSortableTable(columns, rowData)
	]);
}

/* ── Refresh Logic ─────────────────────────────────────────────── */

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

	/* Check if quotas are enabled. */
	var quotas = uci.sections('regulatrix', 'quotas');
	var quotasEnabled = (quotas.length > 0 && quotas[0].enable_quotas === '1');

	/* Fetch tc stats for both directions, plus iptables if quotas are on. */
	var promises = [
		fetchTcStats(ob_dev),
		fetchTcStats(ib_dev),
		quotasEnabled
			? fs.exec_direct('/usr/sbin/iptables',
				['-v', '-x', '-t', 'mangle', '-L', 'POSTROUTING'])
				.catch(function() { return ''; })
			: Promise.resolve('')
	];

	return Promise.all(promises).then(function(results) {
		var obClasses = results[0];
		var ibClasses = results[1];
		var iptablesRaw = results[2];

		while (container.firstChild)
			container.removeChild(container.firstChild);

		/* Rate shaping section. */
		container.appendChild(
			renderShapingTable('outbound', ob_dev, obClasses, nameMap));
		container.appendChild(
			renderShapingTable('inbound', ib_dev, ibClasses, nameMap));

		/* Quota section. */
		if (quotasEnabled) {
			var quotaHosts = parseQuotaStats(iptablesRaw);
			var tcMap = buildTcMap(ibClasses);
			container.appendChild(renderQuotaTable(quotaHosts, tcMap));
		}
	});
}

/* ── View ──────────────────────────────────────────────────────── */

return view.extend({
	load: function() {
		return uci.load('regulatrix');
	},

	render: function() {
		var body = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Regulatrix — Traffic Statistics')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Live counters from the active HTB qdiscs and iptables quota rules. ' +
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

		requestAnimationFrame(function() {
			refreshStats();
		});

		return body;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
