// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "holmes-sidecar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "holmes-sidecar",
            path: "Sources"
        )
    ]
)
