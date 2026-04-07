# Copyright 2026 Cyrus Rahman
# This is free software, licensed under the Apache License, Version 2.0

include $(TOPDIR)/rules.mk

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Cyrus Rahman <crahman@gmail.com>

LUCI_TITLE:=LuCI support for Regulatrix bandwidth control
LUCI_DESCRIPTION:=Provides a web interface for configuring per-device bandwidth \
	regulation via HTB qdiscs and iptables MARK filtering.
LUCI_DEPENDS:=+luci-base +regulatrix
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
