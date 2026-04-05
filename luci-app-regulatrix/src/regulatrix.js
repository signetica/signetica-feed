'use strict';
'require view';
'require form';
'require uci';
'require ui';

/*
 * Validator for bandwidth fields: must be a positive integer.
 * Users enter plain numbers; the "kbit" suffix is handled transparently
 * by cfgvalue (strip on load) and write (append on save).
 */
function validateKbit(section_id, value) {
	if (value == null || value === '')
		return true;  /* Allow empty for optional fields. */
	if (!/^\d+$/.test(value))
		return _('Must be a positive integer (e.g., 300)');
	if (parseInt(value) === 0)
		return _('Bandwidth must be greater than zero');
	return true;
}

/*
 * Configure a form.Value option to display/accept plain numbers while
 * storing "Nkbit" in the UCI config.  Strips "kbit" on load, appends
 * it on save.
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

return view.extend({
	load: function() {
		return uci.load('regulatrix');
	},

	render: function() {
		var m, s, o;

		m = new form.Map('regulatrix', _('Regulatrix — Rate Shaping'),
			_('Regulate upload and download rates for specific devices on your ' +
			  'local network. Useful for cameras and streaming devices that ' +
			  'consume excessive bandwidth.'));

		/* ── Global Settings (two-column layout) ─────────────── */

		s = m.section(form.TypedSection, 'global', _('Global Settings'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Value, 'lan_dev', _('LAN Device'),
			_('Network device where regulated devices reside.'));
		o.placeholder = 'br-lan';
		o.rmempty = false;

		o = s.option(form.Value, 'wan_dev', _('WAN Device'),
			_('Outbound Internet-facing device.'));
		o.placeholder = 'wan';
		o.rmempty = false;

		o = s.option(form.Value, 'inbound_rate', _('Inbound Bandwidth'),
			_('Total available download bandwidth in kbit.'));
		o.rmempty = false;
		kbitOption(o);

		o = s.option(form.Value, 'outbound_rate', _('Outbound Bandwidth'),
			_('Total available upload bandwidth in kbit.'));
		o.rmempty = false;
		kbitOption(o);

		o = s.option(form.Value, 'lan_r2q', _('LAN Rate-to-Quantum'),
			_('HTB r2q divisor. Default 10 is appropriate for most setups.'));
		o.placeholder = '10';
		o.datatype = 'uinteger';
		o.rmempty = false;

		o = s.option(form.Value, 'wan_r2q', _('WAN Rate-to-Quantum'),
			_('HTB r2q divisor. Default 10 is appropriate for most setups.'));
		o.placeholder = '10';
		o.datatype = 'uinteger';
		o.rmempty = false;

		o = s.option(form.Flag, 'enable_inbound_filter',
			_('Enable Inbound Shaping'),
			_('Regulate download bandwidth to specified devices.'));
		o.default = '0';

		o = s.option(form.Flag, 'enable_outbound_filter',
			_('Enable Outbound Shaping'),
			_('Regulate upload bandwidth from specified devices.'));
		o.default = '0';

		/* ── Regulated Devices (compact table) ───────────────── */

		s = m.section(form.TableSection, 'device', _('Regulated Devices'));
		s.description = E('ul', { 'style': 'list-style: disc inside; padding-left: 1.5em;' }, [
			E('li', {}, _('Each device is identified by MAC address and assigned ' +
			  'a traffic class with a guaranteed rate and optional ceiling.')),
			E('li', {}, _('The sum of guaranteed rates for each direction must not ' +
			  'exceed the corresponding channel bandwidth.')),
			E('li', {}, _('Class IDs 1 and 10 are reserved for root and default classes.')),
			E('li', {}, _('Ceilings default to the guaranteed rate if left empty.')),
			E('li', {}, _('All rates are in kbit. Enter the number only (e.g., 300 for 300kbit).'))
		]);
		s.addremove = true;
		s.anonymous = true;
		s.sortable = true;
		s.addbtntitle = _('Add device…');

		o = s.option(form.Flag, 'enabled', _('On'));
		o.default = '1';
		o.width = '5%';

		o = s.option(form.Value, 'device_name', _('Name'));
		o.placeholder = _('e.g., Front Door Camera');
		o.width = '17%';

		o = s.option(form.Value, 'mac_address', _('MAC Address'));
		o.rmempty = false;
		o.datatype = 'macaddr';
		o.width = '14%';

		o = s.option(form.Value, 'id', _('ID'));
		o.rmempty = false;
		o.datatype = 'uinteger';
		o.width = '5%';
		o.validate = function(section_id, value) {
			var id = parseInt(value);
			if (isNaN(id) || id <= 0)
				return _('Must be a positive integer');
			if (id === 1 || id === 10)
				return _('IDs 1 and 10 are reserved');

			var sections = uci.sections('regulatrix', 'device');
			for (var i = 0; i < sections.length; i++) {
				if (sections[i]['.name'] !== section_id &&
				    String(sections[i].id) === String(value))
					return _('Duplicate ID');
			}
			return true;
		};

		o = s.option(form.Value, 'inbound_rate', _('In Rate'));
		o.width = '11%';
		kbitOption(o);

		o = s.option(form.Value, 'inbound_ceil', _('In Ceil'));
		o.width = '11%';
		kbitOption(o);
		o.placeholder = _('= rate');

		o = s.option(form.Value, 'outbound_rate', _('Out Rate'));
		o.width = '11%';
		kbitOption(o);

		o = s.option(form.Value, 'outbound_ceil', _('Out Ceil'));
		o.width = '11%';
		kbitOption(o);
		o.placeholder = _('= rate');

		/* ── Aggregate capacity check on save ────────────────── */

		var origParse = m.parse.bind(m);
		m.parse = function() {
			return origParse().then(function() {
				var globals = uci.sections('regulatrix', 'global');
				var devices = uci.sections('regulatrix', 'device');

				if (!globals.length)
					return;

				var g = globals[0];
				var ib_total = parseInt(g.inbound_rate) || 0;
				var ob_total = parseInt(g.outbound_rate) || 0;
				var ib_sum = 0, ob_sum = 0;

				for (var i = 0; i < devices.length; i++) {
					if (devices[i].enabled === '0')
						continue;
					ib_sum += parseInt(devices[i].inbound_rate) || 0;
					ob_sum += parseInt(devices[i].outbound_rate) || 0;
				}

				var msgs = [];
				if (ib_total > 0 && ib_sum >= ib_total)
					msgs.push(_('Inbound: reserved rates (%skbit) meet or exceed channel capacity (%skbit).')
						.format(ib_sum, ib_total));
				if (ob_total > 0 && ob_sum >= ob_total)
					msgs.push(_('Outbound: reserved rates (%skbit) meet or exceed channel capacity (%skbit).')
						.format(ob_sum, ob_total));

				if (msgs.length > 0) {
					ui.addNotification(
						_('Regulatrix: Capacity Warning'),
						E('p', {}, msgs.join(' ')),
						'warning'
					);
					return Promise.reject(new Error('capacity'));
				}
			});
		};

		return m.render().then(function(mapEl) {
			/* Rearrange global options into two columns. */
			requestAnimationFrame(function() {
				var leftNames  = ['lan_dev', 'inbound_rate',
				                  'lan_r2q', 'enable_inbound_filter'];
				var rightNames = ['wan_dev', 'outbound_rate',
				                  'wan_r2q', 'enable_outbound_filter'];

				var sectionNode = mapEl.querySelector('.cbi-section-node');
				if (!sectionNode)
					return;

				var leftCol  = document.createElement('div');
				var rightCol = document.createElement('div');

				leftNames.forEach(function(name) {
					var el = sectionNode.querySelector('[data-name="' + name + '"]');
					if (el) leftCol.appendChild(el);
				});
				rightNames.forEach(function(name) {
					var el = sectionNode.querySelector('[data-name="' + name + '"]');
					if (el) rightCol.appendChild(el);
				});

				var grid = document.createElement('div');
				grid.style.display = 'grid';
				grid.style.gridTemplateColumns = '1fr 1fr';
				grid.style.gap = '0 2em';
				grid.appendChild(leftCol);
				grid.appendChild(rightCol);

				sectionNode.appendChild(grid);

				var mq = window.matchMedia('(max-width: 768px)');
				function handleResize(e) {
					grid.style.gridTemplateColumns = e.matches ? '1fr' : '1fr 1fr';
				}
				mq.addEventListener('change', handleResize);
				handleResize(mq);
			});

			return mapEl;
		});
	},

});
