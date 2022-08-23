# FIXME: this is a hack code to resolve the build issue for using `base64` module
sed -i -e "s/\"module\".*/\"module\": \".\/lib\/index.js\",/g" ./node_modules/@ethersproject/base64/package.json
rm ./node_modules/@ethersproject/base64/package.json-e