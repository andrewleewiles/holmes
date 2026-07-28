// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "healthkit-sidecar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "healthkit-sidecar",
            path: "Sources"
        )
    ]
)
