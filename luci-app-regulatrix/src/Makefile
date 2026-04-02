# I cannot stand these files being scattered everywhere during development,
# so we put them in place during the build.
compile:

install:
	mkdir -p $(DESTDIR)/www/luci-static/resources/view/regulatrix
	cp regulatrix.js $(DESTDIR)/www/luci-static/resources/view/regulatrix
	cp quotas.js $(DESTDIR)/www/luci-static/resources/view/regulatrix
	cp statistics.js $(DESTDIR)/www/luci-static/resources/view/regulatrix

	mkdir -p $(DESTDIR)/root/usr/share/luci/menu.d
	cp luci-app-regulatrix-menu.json \
		$(DESTDIR)/root/usr/share/luci/menu.d/luci-app-regulatrix.json

	mkdir -p $(DESTDIR)/root/usr/share/rpcd/acl.d
	cp luci-app-regulatrix-acl.json \
		$(DESTDIR)/root/usr/share/rpcd/acl.d/luci-app-regulatrix.json

clean:
