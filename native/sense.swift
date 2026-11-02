// screen-ink-sense: what is on screen, so marks can land on real things instead of guessed coordinates. The app
// starts it once and keeps it running. It reads one JSON request per line on stdin and answers each with one line:
//
//   {"id": 1, "jpeg": "<base64>", "display": [x, y, width, height]}
//   → {"id": 1, "trusted": true, "app": "Safari", "ax": [{"role", "subrole", "label", "frame"}], "ocr": [{"text", "box", "confidence"}]}
//
//   {"id": 2, "type": "text"} → {"id": 2, "trusted": true}   types the text into the app in front
//   {"id": 3, "watch": true}   → {"id": 3, "trusted": true, "watching": true}, then {"click": [x, y]} per click
//
// `ax` is the frontmost app's controls (its menu bar and the windows on that display) from the Accessibility API,
// with frames in global screen points, top-left origin (Electron's coordinates). `ocr` is every line of text Vision
// reads in the image, with boxes as fractions of it. The frontmost app is the last one the user brought forward
// other than screen-ink itself (our parent), whose prompt bar takes focus as the user types.
import AppKit
import ApplicationServices
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

let parent = getppid()
var lastApp: NSRunningApplication? = NSWorkspace.shared.frontmostApplication.flatMap { $0.processIdentifier == parent ? nil : $0 }
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.processIdentifier != parent {
    lastApp = app
  }
}

// ---- Accessibility

let MAX_VISITS = 6000   // elements read, at most
let MAX_FOUND = 600     // elements kept, at most
let BUDGET = 0.8        // seconds spent walking, at most

// Roles worth pointing at; containers are walked through but not kept.
let KEEP: Set<String> = [
  "AXButton", "AXMenuBarItem", "AXMenuItem", "AXMenuButton", "AXPopUpButton", "AXComboBox", "AXTextField", "AXTextArea",
  "AXSearchField", "AXCheckBox", "AXRadioButton", "AXLink", "AXSlider", "AXDisclosureTriangle", "AXIncrementor",
  "AXColorWell", "AXStaticText", "AXImage", "AXHeading", "AXCell", "AXRow", "AXTab",
]
// Roles whose insides are part of them (a button's label, a field's text).
let LEAF: Set<String> = [
  "AXButton", "AXMenuButton", "AXPopUpButton", "AXComboBox", "AXTextField", "AXTextArea", "AXSearchField", "AXCheckBox",
  "AXRadioButton", "AXSlider", "AXStaticText", "AXImage", "AXIncrementor", "AXColorWell", "AXDisclosureTriangle",
]
// Roles that cut off what lies outside them (a list scrolled past its edge).
let CLIPS: Set<String> = ["AXScrollArea", "AXWindow", "AXSheet", "AXDrawer", "AXPopover", "AXMenu"]

let ATTRS = [
  kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
  "AXPlaceholderValue", kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute, kAXSelectedAttribute,
] as CFArray

/// The attributes in ATTRS, nil where the element has none.
func read(_ el: AXUIElement) -> [Any?]? {
  var out: CFArray?
  guard AXUIElementCopyMultipleAttributeValues(el, ATTRS, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
        let values = out as? [Any] else { return nil }
  return values.map { v in
    let ref = v as CFTypeRef
    if CFGetTypeID(ref) == AXValueGetTypeID(), AXValueGetType(ref as! AXValue) == .axError { return nil }
    return v
  }
}

func frame(_ position: Any?, _ size: Any?) -> CGRect? {
  guard let p = position, let s = size else { return nil }
  var origin = CGPoint.zero, extent = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &extent) else { return nil }
  return CGRect(origin: origin, size: extent)
}

func text(_ v: Any?) -> String {
  guard let s = v as? String else { return "" }
  let line = s.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
  return String(line.trimmingCharacters(in: .whitespaces).prefix(80))
}

func copy(_ el: AXUIElement, _ attr: String) -> Any? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
}

func walk(app: NSRunningApplication, display: CGRect) -> [[String: Any]] {
  let root = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(root, 0.25)
  // Electron apps (Slack, VS Code, ...) only build their accessibility tree once someone asks for it.
  AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)

  var starts: [(AXUIElement, CGRect)] = []
  if let bar = copy(root, kAXMenuBarAttribute) { starts.append((bar as! AXUIElement, display)) }
  for w in (copy(root, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { starts.append((w, display)) }

  let deadline = Date().addingTimeInterval(BUDGET)
  var found: [[String: Any]] = []
  var covered: [CGRect] = [] // windows already walked: whatever lies under them is hidden
  var visits = 0
  for (start, clip) in starts {
    var stack: [(AXUIElement, CGRect, Int)] = [(start, clip, 0)]
    var isWindow = true
    while let next = stack.popLast() {
      let (el, clip, depth) = next
      visits += 1
      if visits > MAX_VISITS || found.count >= MAX_FOUND || Date() > deadline { return found }
      guard let v = read(el) else { continue }
      let role = (v[0] as? String) ?? ""
      let subrole = (v[1] as? String) ?? ""
      let box = frame(v[6], v[7])
      if isWindow {
        isWindow = false
        if role == "AXWindow", let b = box {
          if !b.intersects(display) || covered.contains(where: { $0.contains(b) }) { break }
        }
      }
      var inner = clip
      if let b = box, CLIPS.contains(role) { inner = clip.intersection(b) }
      if let b = box, KEEP.contains(role), b.width >= 3, b.height >= 3 {
        let seen = b.intersection(clip)
        let centre = CGPoint(x: b.midX, y: b.midY)
        let hidden = role != "AXMenuBarItem" && covered.contains(where: { $0.contains(centre) })
        if !seen.isNull, seen.width * seen.height >= 0.6 * b.width * b.height, display.contains(centre), !hidden {
          let label = [text(v[2]), text(v[3]), text(v[5]), role == "AXTextField" || role == "AXTextArea" ? "" : text(v[4])].first { !$0.isEmpty } ?? ""
          found.append(["role": role, "subrole": subrole, "label": label, "frame": [b.minX, b.minY, b.width, b.height]])
        }
      }
      // Closed menus still list every item; only an open one (selected) is on screen.
      if LEAF.contains(role) || ((role == "AXMenuBarItem" || role == "AXMenuItem") && (v[9] as? Bool) != true) { continue }
      if depth >= 60 { continue }
      for child in ((v[8] as? [AXUIElement]) ?? []).reversed() { stack.append((child, inner, depth + 1)) }
    }
    if let w = copy(start, kAXRoleAttribute) as? String, w == "AXWindow",
       let b = frame(copy(start, kAXPositionAttribute), copy(start, kAXSizeAttribute)) { covered.append(b) }
  }
  return found
}

// ---- Text

func recognize(_ data: Data) -> [[String: Any]] {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return [] }
  return recognize(image)
}

func recognize(_ image: CGImage) -> [[String: Any]] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.automaticallyDetectsLanguage = true
  try? VNImageRequestHandler(cgImage: image).perform([request])
  guard let gray = Gray(image) else { return [] }
  let width = Double(image.width), height = Double(image.height)
  return (request.results ?? []).flatMap { line -> [[String: Any]] in
    guard let best = line.topCandidates(1).first else { return [] }
    let s = best.string
    // Vision's boxes are fractions of the image, origin bottom left; these are pixels, origin top left.
    let top = Int((1 - line.boundingBox.maxY) * height), bottom = Int((1 - line.boundingBox.minY) * height)
    let lineHeight = Double(bottom - top)
    // Vision joins words that merely share a baseline (a menu bar's titles, a toolbar's labels, table columns), and
    // its word boxes fill the spaces between words, so they can't say how far apart the words are. The pixels can:
    // each word's ink starts and ends where its columns stop being one flat colour.
    var words: [(range: Range<String.Index>, ink: ClosedRange<Int>?)] = []
    s.enumerateSubstrings(in: s.startIndex..., options: .byWords) { _, range, _, _ in
      guard let b = (try? best.boundingBox(for: range))??.boundingBox else { return }
      words.append((range, gray.ink(Int(b.minX * width), Int(b.maxX * width), top, bottom)))
    }
    // Split the line where the gap between two words' ink is wider than about a line's height.
    var runs: [(range: Range<String.Index>, ink: ClosedRange<Int>?)] = []
    for w in words {
      if let last = runs.last, let a = last.ink, let b = w.ink, Double(b.lowerBound - a.upperBound) > 0.8 * lineHeight {
        runs.append(w)
      } else if let last = runs.last {
        let ink = [last.ink, w.ink].compactMap { $0 }.reduce(nil as ClosedRange<Int>?) { r, x in r.map { min($0.lowerBound, x.lowerBound)...max($0.upperBound, x.upperBound) } ?? x }
        runs[runs.count - 1] = (last.range.lowerBound..<w.range.upperBound, ink)
      } else {
        runs.append(w)
      }
    }
    let whole = runs.count < 2
    return (whole ? [(s.startIndex..<s.endIndex, runs.first?.ink)] : runs).map { run in
      // The box hugs the ink across, which rings and underlines want; Vision's own box when there was none to find.
      let x0 = run.ink.map { Double($0.lowerBound) / width } ?? line.boundingBox.minX
      let x1 = run.ink.map { Double($0.upperBound + 1) / width } ?? line.boundingBox.maxX
      return ["text": String(s[run.range]), "box": [x0, Double(top) / height, x1 - x0, lineHeight / height], "confidence": best.confidence]
    }
  }
}

/// The image in grey, to find where text's ink is.
final class Gray {
  let width: Int, height: Int
  var pixels: [UInt8]

  init?(_ image: CGImage) {
    width = image.width
    height = image.height
    pixels = [UInt8](repeating: 0, count: width * height)
    let drawn = pixels.withUnsafeMutableBytes { buf -> Bool in
      guard let ctx = CGContext(data: buf.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    if !drawn { return nil }
  }

  /// The first and last columns between x0 and x1 that carry ink in rows top..<bottom: a column whose darkest and
  /// lightest pixels differ clearly, where a blank one is a single colour (or a gentle gradient).
  func ink(_ x0: Int, _ x1: Int, _ top: Int, _ bottom: Int) -> ClosedRange<Int>? {
    let rows = max(0, top + 1)..<min(height, bottom - 1)
    var first: Int?, last: Int?
    for x in max(0, x0)..<min(width, x1) where !rows.isEmpty {
      var lo: UInt8 = 255, hi: UInt8 = 0
      for y in rows {
        let p = pixels[y * width + x]
        lo = min(lo, p)
        hi = max(hi, p)
      }
      if hi - lo > 48 {
        if first == nil { first = x }
        last = x
      }
    }
    guard let f = first, let l = last else { return nil }
    return f...l
  }
}

// ---- Typing, for a button the user clicked

/** Types `text` into the app in front, a few characters per key event. Needs Accessibility. */
func type(_ text: String) {
  let units = Array(text.utf16)
  var i = 0
  while i < units.count {
    let chunk = Array(units[i..<min(i + 16, units.count)])
    for down in [true, false] {
      guard let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { continue }
      e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      e.post(tap: .cghidEventTap)
    }
    i += 16
    usleep(4000)
  }
}

// ---- Watching clicks, for walkthroughs: each left click anywhere, in global points, top-left origin.

var clicks: CFMachPort?

func watch(_ on: Bool) -> Bool {
  if !on {
    if let tap = clicks { CGEvent.tapEnable(tap: tap, enable: false) }
    return false
  }
  if let tap = clicks {
    CGEvent.tapEnable(tap: tap, enable: true)
    return true
  }
  let mask = CGEventMask(1 << CGEventType.leftMouseDown.rawValue)
  guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask,
                                    callback: { _, kind, event, _ in
    if kind == .tapDisabledByTimeout || kind == .tapDisabledByUserInput {
      if let tap = clicks { CGEvent.tapEnable(tap: tap, enable: true) }
    } else if kind == .leftMouseDown {
      let p = event.location
      print("{\"click\": [\(p.x), \(p.y)]}")
    }
    return Unmanaged.passUnretained(event)
  }, userInfo: nil) else { return false }
  clicks = tap
  CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  return true
}

// ---- Requests

func answer(_ request: [String: Any]) -> [String: Any] {
  var reply: [String: Any] = ["id": request["id"] ?? NSNull(), "trusted": AXIsProcessTrusted()]
  if let text = request["type"] as? String {
    if AXIsProcessTrusted() { type(text) }
    return reply
  }
  if let on = request["watch"] as? Bool {
    reply["watching"] = DispatchQueue.main.sync { watch(on) }
    return reply
  }
  let d = (request["display"] as? [Double]) ?? []
  let display = d.count == 4 ? CGRect(x: d[0], y: d[1], width: d[2], height: d[3]) : .infinite
  let app = DispatchQueue.main.sync { lastApp }
  var ax: [[String: Any]] = [], ocr: [[String: Any]] = []
  let group = DispatchGroup()
  if let app, AXIsProcessTrusted() {
    reply["app"] = app.localizedName ?? ""
    DispatchQueue.global().async(group: group) { ax = walk(app: app, display: display) }
  }
  // The screenshot comes inline (base64), so it never touches the disk; `image`, a file, is for trying it by hand.
  let image = (request["jpeg"] as? String).flatMap { Data(base64Encoded: $0) }
    ?? (request["image"] as? String).flatMap { FileManager.default.contents(atPath: $0) }
  if let image {
    DispatchQueue.global().async(group: group) { ocr = recognize(image) }
  }
  group.wait()
  reply["ax"] = ax
  reply["ocr"] = ocr
  return reply
}

let work = DispatchQueue(label: "sense")
// Vision's accurate model takes about half a minute to load the first time a binary uses it (it is cached after
// that), and a second or so on later launches: load it now, on a word, rather than on the user's first question.
work.async {
  let space = CGColorSpaceCreateDeviceRGB()
  guard let ctx = CGContext(data: nil, width: 240, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
  ctx.setFillColor(.white)
  ctx.fill(CGRect(x: 0, y: 0, width: 240, height: 64))
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  ("Ready" as NSString).draw(at: CGPoint(x: 24, y: 16), withAttributes: [.font: NSFont.systemFont(ofSize: 28)])
  if let image = ctx.makeImage() { _ = recognize(image) }
}
var pending = Data()
FileHandle.standardInput.readabilityHandler = { handle in
  let chunk = handle.availableData
  if chunk.isEmpty { exit(0) } // the app quit
  pending.append(chunk)
  while let nl = pending.firstIndex(of: 0x0A) {
    let line = pending[pending.startIndex..<nl]
    pending = Data(pending[pending.index(after: nl)...])
    guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
    work.async {
      let reply = answer(request)
      if let out = try? JSONSerialization.data(withJSONObject: reply), let s = String(data: out, encoding: .utf8) { print(s) }
    }
  }
}

RunLoop.main.run()
