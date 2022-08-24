# FIXME: this is a hack code to resolve the build issue for using `base64` module
sed -i -e "s/\"module\".*/\"module\": \".\/lib\/index.js\",/g" ./node_modules/@ethersproject/base64/package.json

ERROR_FILE="./node_modules/@ethersproject/base64/package.json-e"

if [ -f $ERROR_FILE ] ; then
    rm $ERROR_FILE
fi