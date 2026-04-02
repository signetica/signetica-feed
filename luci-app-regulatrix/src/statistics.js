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

	for (var i = 0; i < shaping.length; i++) {
		var c = shaping[i];
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

/* ── Quota Statistics ──────────────────────────────────────────── */

/*
 * Parse `iptables -v -x -t mangle -L POSTROUTING` output into per-host
 * quota state.  Rules come in groups of three per host:
 *   Rule 3 (unconditional): floor tier mark — total traffic
 *   Rule 2 (quota2 gated):  T2 mark — traffic while T2 quota active
 *   Rule 1 (quota2 gated):  T1 mark — traffic while T1 quota active
 *
 * Returns an array of:
 *   { name, ip_octet, sent_bytes, tier, t1_bytes, t2_bytes }
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
	 * Order: Rule 3 (unconditional), Rule 2 (T2 gated), Rule 1 (T1 gated). */
	for (var i = 0; i + 2 < rules.length; i += 3) {
		var r3 = rules[i];      /* Unconditional — total traffic */
		var r2 = rules[i + 1];  /* T2 quota gated */
		var r1 = rules[i + 2];  /* T1 quota gated */

		/* Recover IP octet from the mark.  Mark format is ${ip}00N decimal,
		 * so integer division by 1000 gives the last octet. */
		var ip_octet = Math.floor(r3.mark / 1000);

		/* Determine active tier by comparing byte counts.
		 * If T1 rule bytes == total bytes → still in Tier 1.
		 * If T2 rule bytes == total bytes but T1 < total → Tier 2.
		 * If T2 rule bytes < total bytes → Tier 3. */
		var tier;
		if (r1.bytes >= r3.bytes && r3.bytes > 0)
			tier = 1;
		else if (r2.bytes >= r3.bytes && r3.bytes > 0)
			tier = 2;
		else if (r3.bytes > 0)
			tier = 3;
		else
			tier = 1;  /* No traffic yet — effectively Tier 1. */

		hosts.push({
			name:      r3.dest,
			ip_octet:  ip_octet,
			sent_bytes: r3.bytes,
			tier:      tier,
			t1_bytes:  r1.bytes,
			t2_bytes:  r2.bytes
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

	var rows = [
		E('tr', { 'class': 'tr cbi-section-table-titles' }, [
			E('th', { 'class': 'th' }, _('Name / IP')),
			E('th', { 'class': 'th' }, _('Sent')),
			E('th', { 'class': 'th' }, _('Tier')),
			E('th', { 'class': 'th' }, _('Tier Limit')),
			E('th', { 'class': 'th' }, _('Ceiling')),
			E('th', { 'class': 'th' }, _('Actual')),
			E('th', { 'class': 'th' }, _('Dropped')),
			E('th', { 'class': 'th' }, _('Overlimits'))
		])
	];

	for (var i = 0; i < quotaHosts.length; i++) {
		var h = quotaHosts[i];

		/* Tier limit and ceiling for the active tier. */
		var tierLimit, ceiling;
		switch (h.tier) {
			case 1:
				tierLimit = humanBytes(t1_quota);
				ceiling = t1_ceil;
				break;
			case 2:
				tierLimit = humanBytes(t1_quota + t2_quota);
				ceiling = t2_ceil;
				break;
			default:
				tierLimit = '—';
				ceiling = t3_ceil;
		}

		/* Look up tc stats for the active class in the 2:* subtree.
		 * Classid format: 2:${ip_octet}${tier} */
		var tcClassId = '2:' + h.ip_octet + h.tier;
		var tc = tcMap[tcClassId];
		var actual   = tc ? tc.actual_rate   : '—';
		var dropped  = tc ? String(tc.dropped)    : '—';
		var overlim  = tc ? String(tc.overlimits) : '—';

		rows.push(E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, h.name),
			E('td', { 'class': 'td' }, humanBytes(h.sent_bytes)),
			E('td', { 'class': 'td' }, String(h.tier)),
			E('td', { 'class': 'td' }, tierLimit),
			E('td', { 'class': 'td' }, ceiling),
			E('td', { 'class': 'td' }, actual),
			E('td', { 'class': 'td' }, dropped),
			E('td', { 'class': 'td' }, overlim)
		]));
	}

	return E('div', {}, [
		E('h4', {}, _('Quota-Based Shaping')),
		E('table', { 'class': 'table cbi-section-table' }, rows)
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
