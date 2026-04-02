hier:
	mkdir -p htdocs/luci-static/resources/view/regulatrix
	install -c -m 644 regulatrix.js \
		htdocs/luci-static/resources/view/regulatrix
	install -c -m 644 quotas.js \
		htdocs/luci-static/resources/view/regulatrix
	install -c -m 644 statistics.js \
		htdocs/luci-static/resources/view/regulatrix

	mkdir -p root/usr/share/luci/menu.d
	install -c -m 644 luci-app-regulatrix-menu.json \
		root/usr/share/luci/menu.d/luci-app-regulatrix.json

	mkdir -p root/usr/share/rpcd/acl.d
	install -c -m 644 luci-app-regulatrix-acl.json \
		root/usr/share/rpcd/acl.d/luci-app-regulatrix.json

clean:
	rm -rf htdocs root
