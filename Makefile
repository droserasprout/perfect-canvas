install:
	cd native && ./install.sh

build:
	zip -r -FS ../my-extension.zip * \
		--exclude '*.git*' \
		--exclude '*cache*' \
		--exclude '*.zip' \
		--exclude 'screenshot.png' \
		--exclude '*.md' \
		--exclude 'native/*'