# I cannot stand these files being scattered everywhere during development,
# so we put them in place during the build.
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

# Needless to say, it's not that easy.  We have to create something for the build
# environment to play with.
install:
	mkdir -p $(DESTDIR)/tmp
	touch $(DESTDIR)/tmp/regulatrix.done

# While the target must exist, the rest is just for keeping the repo clean during
# development.
clean:
	rm -rf ../htdocs ../root

