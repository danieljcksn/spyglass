UUID    := workstation-monitor@dan
SRC     := src
DEST    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA  := org.gnome.shell.extensions.workstation-monitor.gschema.xml

.PHONY: help install uninstall schemas test test-lib test-draw pack lint clean

help:
	@echo "install    copy the extension into place and compile its schema"
	@echo "uninstall  remove the installed copy (settings in dconf are kept)"
	@echo "test       run both offline suites"
	@echo "pack       build a zip for extensions.gnome.org"
	@echo ""
	@echo "After install, restart GNOME Shell: Alt+F2, type r, Enter (X11)."
	@echo "Do NOT use 'gnome-shell --replace': it starts a shell outside"
	@echo "systemd, takes the org.gnome.Shell bus name, and drops the"
	@echo "session into the 'Oh no' screen when the real unit cannot start."

schemas:
	glib-compile-schemas $(SRC)/schemas/

install: schemas
	@mkdir -p $(DEST)
	@cp -r $(SRC)/. $(DEST)/
	@echo "installed to $(DEST)"
	@echo "now restart the Shell: Alt+F2, r, Enter"

uninstall:
	@rm -rf $(DEST)
	@echo "removed $(DEST)"

# Both suites run under plain gjs, with no gnome-shell involved. test-lib hits
# /proc, /sys and nvidia-smi for real; pass a Glances base URL to also exercise
# the remote client against a live agent:
#   make test-lib WSM_TEST_HOST=http://192.168.0.81:61208/api/4
test-lib:
	@cd tests && WSM_TEST_HOST=$(WSM_TEST_HOST) gjs -m test-lib.js

test-draw:
	@mkdir -p build
	@cd tests && gjs -m test-draw.js ../build
	@echo "wrote build/sparklines.png — look at it"

test: test-lib test-draw

pack: schemas
	@cd $(SRC) && gnome-extensions pack --force \
		--extra-source=lib.js \
		--extra-source=widgets.js \
		--extra-source=draw.js \
		--out-dir=..
	@echo "packed $(UUID).shell-extension.zip"

clean:
	@rm -rf build *.shell-extension.zip $(SRC)/schemas/gschemas.compiled
