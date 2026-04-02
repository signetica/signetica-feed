'use strict';
'require view';
'require form';
'require uci';
'require ui';

/*
 * Validator for bandwidth fields: must be a positive integer.
 */
function validateKbit(section_id, value) {
	if (value == null || value === '')
		return true;
	if (!/^\d+$/.test(value))
		return _('Must be a positive integer (e.g., 300)');
	if (parseInt(value) === 0)
		return _('Bandwidth must be greater than zero');
	return true;
}

/*
 * Configure a form.Value option to display/accept plain numbers while
 * storing "Nkbit" in the UCI config.
 */
function kbitOption(o) {
	o.placeholder = _('kbit');
	o.validate = validateKbit;
	o.cfgvalue = function(section_id) {
		var val = uci.get('regulatrix', section_id, this.option);
		if (val)
			return val.replace(/kbit$/, '');
		return val;
	};
	o.write = function(section_id, value) {
		if (value != null && value !== '' && !/kbit$/.test(value))
			value = value + 'kbit';
		uci.set('regulatrix', section_id, this.option, value);
	};
	return o;
}

/*
 * Configure a form.Value option to display/accept megabytes while
 * storing bytes in the UCI config.
 */
function mbOption(o) {
	o.placeholder = _('MB');
	o.datatype = 'uinteger';
	o.validate = function(section_id, value) {
		if (value == null || value === '')
			return true;
		if (!/^\d+$/.test(value))
			return _('Must be a positive integer (e.g., 128)');
		if (parseInt(value) === 0)
			return _('Quota must be greater than zero');
		return true;
	};
	o.cfgvalue = function(section_id) {
		var val = uci.get('regulatrix', section_id, this.option);
		if (val)
			return String(Math.round(parseInt(val) / 1000000));
		return val;
	};
	o.write = function(section_id, value) {
		if (value != null && value !== '')
			value = String(parseInt(value) * 1000000);
		uci.set('regulatrix', section_id, this.option, value);
	};
	return o;
}

return view.extend({
	load: function() {
		return uci.load('regulatrix');
	},

	render: function() {
		var m, s, o;

		m = new form.Map('regulatrix', _('Regulatrix — Bandwidth Quotas'),
			_('Quota-based traffic shaping for the DHCP address range. ' +
			  'Devices start at full speed and are progressively ' +
			  'throttled as they consume data, encouraging lower-resolution ' +
			  'streaming without blocking access.'));

		s = m.section(form.TypedSection, 'quotas', _('Quota Settings'));
		s.anonymous = true;
		s.addremove = false;
		s.description = E('div', {}, [
			E('ul', {}, [
				E('li', {}, _('Applies to the DHCP dynamic address range, ' +
				  'covering transient devices like phones and tablets.')),
				E('li', {}, _('Each IP starts in Tier 1 (full speed). When its ' +
				  'Tier 1 quota is exhausted, it drops to Tier 2. When Tier 2 ' +
				  'is exhausted, it drops to Tier 3.')),
				E('li', {}, _('Tier 3 has no quota — it is the floor rate that ' +
				  'applies for the remainder of the quota period.')),
				E('li', {}, _('Quotas are cumulative byte counters that persist ' +
				  'until reset. Set up a cron job to restart regulatrix ' +
				  'daily (e.g., shortly after midnight) to reset all quotas.')),
				E('li', {}, _('All rates are in kbit. Quotas are entered in MB.'))
			])
		]);

		o = s.option(form.Flag, 'enable_quotas', _('Enable Quotas'),
			_('Enable quota-based shaping for the address range below.'));
		o.default = '0';

		/* ── Address Range ───────────────────────────────────── */

		o = s.option(form.Value, 'lan_addr', _('LAN Address'),
			_('LAN network address (e.g., 192.168.1.0). The last octet ' +
			  'is stripped to form the prefix for quota rules.'));
		o.placeholder = '192.168.1.0';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (value == null || value === '')
				return true;
			if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value))
				return _('Must be a valid IPv4 address (e.g., 192.168.1.0)');
			var parts = value.split('.');
			for (var i = 0; i < parts.length; i++) {
				if (parseInt(parts[i]) > 255)
					return _('Each octet must be 0–255');
			}
			return true;
		};

		o = s.option(form.Value, 'range_start', _('Range Start'),
			_('First host address (last octet) to apply quotas.'));
		o.placeholder = '50';
		o.datatype = 'range(1,254)';
		o.rmempty = false;

		o = s.option(form.Value, 'range_end', _('Range End'),
			_('Last host address (last octet) to apply quotas.'));
		o.placeholder = '75';
		o.datatype = 'range(1,254)';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (value == null || value === '')
				return true;
			var start = uci.get('regulatrix', section_id, 'range_start');
			if (start && parseInt(value) < parseInt(start))
				return _('Must be greater than or equal to range start');
			return true;
		};

		/* ── Tier 1: Full Speed ──────────────────────────────── */

		o = s.option(form.Value, 't1_rate', _('Tier 1 Ceiling'),
			_('Maximum bandwidth while under Tier 1 quota.'));
		o.rmempty = false;
		kbitOption(o);

		o = s.option(form.Value, 't1_quota', _('Tier 1 Quota'),
			_('Data allowance before demotion to Tier 2.'));
		o.rmempty = false;
		mbOption(o);

		/* ── Tier 2: Reduced ─────────────────────────────────── */

		o = s.option(form.Value, 't2_rate', _('Tier 2 Ceiling'),
			_('Maximum bandwidth after Tier 1 quota is exhausted.'));
		o.rmempty = false;
		kbitOption(o);

		o = s.option(form.Value, 't2_quota', _('Tier 2 Quota'),
			_('Additional data allowance before demotion to Tier 3.'));
		o.rmempty = false;
		mbOption(o);

		/* ── Tier 3: Floor ───────────────────────────────────── */

		o = s.option(form.Value, 't3_rate', _('Tier 3 Rate'),
			_('Floor bandwidth after all quotas are exhausted. ' +
			  'This is both the guaranteed rate and ceiling for each ' +
			  'host in the range.'));
		o.rmempty = false;
		kbitOption(o);

		/* ── Capacity validation ─────────────────────────────── */

		var origParse = m.parse.bind(m);
		m.parse = function() {
			return origParse().then(function() {
				var quotas = uci.sections('regulatrix', 'quotas');
				if (!quotas.length)
					return;

				var q = quotas[0];
				if (q.enable_quotas !== '1')
					return;

				var start = parseInt(q.range_start) || 0;
				var end   = parseInt(q.range_end) || 0;
				var tc3   = parseInt(q.t3_rate) || 0;
				var hosts = end - start + 1;

				if (hosts <= 0)
					return;

				var globals = uci.sections('regulatrix', 'global');
				if (!globals.length)
					return;

				var ib_total = parseInt(globals[0].inbound_rate) || 0;
				if (ib_total <= 0)
					return;

				/* Sum up rate-shaping device reservations. */
				var devices = uci.sections('regulatrix', 'device');
				var dev_reserved = 0;
				for (var i = 0; i < devices.length; i++) {
					if (devices[i].enabled === '0')
						continue;
					dev_reserved += parseInt(devices[i].inbound_rate) || 0;
				}

				var unreserved = ib_total - dev_reserved;
				var quota_reserved = hosts * tc3;

				if (quota_reserved >= unreserved) {
					ui.addNotification(
						_('Regulatrix: Capacity Warning'),
						E('p', {},
							_('Quota floor rates (%d hosts × %dkbit = %dkbit) ' +
							  'meet or exceed unreserved inbound bandwidth (%dkbit).')
							.format(hosts, tc3, quota_reserved, unreserved)),
						'warning'
					);
					return Promise.reject(new Error('capacity'));
				}
			});
		};

		return m.render();
	},

});
