import UIKit
import UniformTypeIdentifiers

/// Share → Map to GPX.
///
/// Takes whatever Google Maps (or Safari, or Messages) shares -- a link, or a
/// sentence with a link in it -- leaves it in the App Group where the
/// share-target plugin looks, and opens the app, which fills the link in and
/// converts it. Nothing is routed here: an extension gets little memory and
/// less time, and the app already has everything it needs.
///
/// If the app cannot be opened from here, the link still waits in the group
/// and is picked up the next time the app comes to the foreground.
@objc(ShareViewController)
class ShareViewController: UIViewController {
    private let appGroup = "group.com.maptogpx.app"
    private let key = "share-target-data"
    private var handedOff = false

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !handedOff else { return }
        handedOff = true
        Task { await handOff() }
    }

    private func handOff() async {
        var texts: [String] = []
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        for item in items {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
                   !url.isFileURL {
                    texts.append(url.absoluteString)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    texts.append(text)
                }
            }
            if let text = item.attributedContentText?.string, !text.isEmpty {
                texts.append(text)
            }
        }

        if !texts.isEmpty, let group = UserDefaults(suiteName: appGroup) {
            group.set(["title": "", "texts": texts, "files": []] as [String: Any], forKey: key)
            await MainActor.run { openApp(URL(string: "maptogpx://share")!) }
        }
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// An extension has no UIApplication.shared, and open(_:options:) is
    /// marked unavailable to extensions at compile time -- but the application
    /// object is at the end of the responder chain, and the method is there at
    /// run time.
    private func openApp(_ url: URL) {
        typealias OpenURL = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?) -> Void
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current is UIApplication,
               let method = class_getInstanceMethod(type(of: current), selector) {
                let open = unsafeBitCast(method_getImplementation(method), to: OpenURL.self)
                open(current, selector, url as NSURL, NSDictionary(), nil)
                return
            }
            responder = current.next
        }
    }
}
