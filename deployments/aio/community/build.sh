#!/bin/bash

set -e

DIST_DIR=${DIST_DIR:-./dist}
IMAGE_NAMESPACE=${IMAGE_NAMESPACE:-makeplane}
IMAGE_NAME=${IMAGE_NAME:-$IMAGE_NAMESPACE/plane-aio-community}


# loop though all flags and set the variables
for arg in "$@"; do
    case $arg in
        --release)
            APP_RELEASE_VERSION="$2"
            shift
            shift
            ;;
        --release=*)
            APP_RELEASE_VERSION="${arg#*=}"
            shift
            ;;
        --image-name)
            IMAGE_NAME="$2"
            shift
            shift
            ;;
        --image-name=*)
            IMAGE_NAME="${arg#*=}"
            shift
            ;;
    esac
done


if [ -z "$APP_RELEASE_VERSION" ]; then
    echo ""
    echo "Usage: "
    echo "   ./build.sh [flags]"
    echo ""
    echo "Flags:"
    echo "  --release=<APP_RELEASE_VERSION>     required (e.g. v0.27.1)"
    echo ""
    echo "Example: ./build.sh --release=v0.27.1 --platform=linux/amd64"
    exit 1
fi

cd $(dirname "$0")

string_replace(){
    local file="$1"
    local search="$2"
    local replace="$3"
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|$search|$replace|g" "$file"
    else
        sed -i "s|$search|$replace|g" "$file"
    fi
}
remove_line(){
    local file="$1"
    local line="$2"

    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' '/'$line'/d' "$file"
    else
        sed -i '/'$line'/d' "$file"
    fi
}

update_env_file(){
    local file="$1"
    local key="$2"
    local value="$3"

    # if key is in file, replace it
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' 's|^'$key'=.*|'$key'='$value'|' "$file"
    else
        sed -i 's|^'$key'=.*|'$key'='$value'|' "$file"
    fi

    # if key not in file, add it
    if ! grep -q "^$key=" "$file"; then
        echo "$key=$value" >> "$file"
    fi
}

build_dist_files(){
    cp ./variables.env $DIST_DIR/plane.env
    cp ../../../apps/proxy/Caddyfile.aio.ce $DIST_DIR/Caddyfile

    echo "" >> $DIST_DIR/plane.env
    echo "" >> $DIST_DIR/plane.env

    # update the plane.env file with the APP_RELEASE_VERSION
    update_env_file $DIST_DIR/plane.env "APP_RELEASE_VERSION" "$APP_RELEASE_VERSION"
    update_env_file $DIST_DIR/plane.env "APP_RELEASE" "$APP_RELEASE_VERSION"
    update_env_file $DIST_DIR/plane.env "APP_VERSION" "$APP_RELEASE_VERSION"
    
    update_env_file $DIST_DIR/plane.env "API_BASE_URL" "http://localhost:3004"
    update_env_file $DIST_DIR/plane.env "SITE_ADDRESS" ":80"

    # Ship deployment files from the same preparation step as the image config.
    mkdir -p "$DIST_DIR/release"
    cp ./docker-compose.yml "$DIST_DIR/release/docker-compose.yml"
    cp ./docker-compose.full.yml "$DIST_DIR/release/docker-compose.full.yml"
    cp ./init-stack.sh "$DIST_DIR/release/init-stack.sh"
    cp "$DIST_DIR/plane.env" "$DIST_DIR/release/variables.env"
    cp ./README.md "$DIST_DIR/release/README.md"
    string_replace "$DIST_DIR/release/docker-compose.yml" 'APP_RELEASE:-stable' "APP_RELEASE:-$APP_RELEASE_VERSION"
    string_replace "$DIST_DIR/release/docker-compose.yml" 'makeplane/plane-aio-community' "$IMAGE_NAME"
    string_replace "$DIST_DIR/release/docker-compose.full.yml" 'APP_RELEASE:-stable' "APP_RELEASE:-$APP_RELEASE_VERSION"
    string_replace "$DIST_DIR/release/docker-compose.full.yml" 'ghcr.io/dlsinnocence/plane-aio-community' "$IMAGE_NAME"

    # print docker build command
    echo "------------------------------------------------"
    echo "Run the following command to build the image:"
    echo "------------------------------------------------"
    echo ""
    echo "docker build -t $IMAGE_NAME \\"
    echo "  -f $(pwd)/Dockerfile \\"
    echo "  --build-arg IMAGE_NAMESPACE=$IMAGE_NAMESPACE \\"
    echo "  --build-arg PLANE_VERSION=$APP_RELEASE_VERSION \\"
    echo "  $(pwd)"
    echo ""
    echo "------------------------------------------------"
}


main(){
    # check if the dist directory exists
    echo ""
    if [ -d "$DIST_DIR" ]; then
        echo "Cleaning existing dist directory..."
        rm -rf $DIST_DIR
    fi
    echo "Creating dist directory..." 
    mkdir -p $DIST_DIR
    echo ""

    build_dist_files
    if [ $? -ne 0 ]; then
        echo "Error: Failed to build docker image"
        exit 1
    fi
}

main "$@"

