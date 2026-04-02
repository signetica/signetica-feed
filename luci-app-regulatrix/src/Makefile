compile:
	mkdir -p ../htdocs/luci-static/resources/view/regulatrix
	cp regulatrix.js ../htdocs/luci-static/resources/view/regulatrix
	cp quotas.js ../htdocs/luci-static/resources/view/regulatrix
	cp statistics.js ../htdocs/luci-static/resources/view/regulatrix

	mkdir -p ../root/usr/share/luci/menu.d
	cp luci-app-regulatrix-menu.json \
		../root/usr/share/luci/menu.d/luci-app-regulatrix.json

	mkdir -p ../root/usr/share/rpcd/acl.d
	cp luci-app-regulatrix-acl.json \
		../root/usr/share/rpcd/acl.d/luci-app-regulatrix.json

clean:
	rm -rf ../htdocs ../root

install:
