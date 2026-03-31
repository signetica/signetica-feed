# Copyright 2026 Cyrus Rahman
# This is free software, licensed under the Apache License, Version 2.0

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-regulatrix
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_MAINTAINER:=Cyrus Rahman <crahman@gmail.com>
PKG_LICENSE:=Apache-2.0

LUCI_TITLE:=LuCI support for Regulatrix bandwidth control
LUCI_DESCRIPTION:=Provides a web interface for configuring per-device bandwidth \
	regulation via HTB qdiscs and iptables MARK filtering.
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
