import Foundation
import ApplicationServices
import AppKit

func attribute(_ node: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?; return AXUIElementCopyAttributeValue(node, name, &value) == .success ? value : nil
}
func text(_ node: AXUIElement, _ name: CFString) -> String { attribute(node, name) as? String ?? "" }
func children(_ node: AXUIElement) -> [AXUIElement] { attribute(node, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? [] }
func descendants(_ node: AXUIElement, depth: Int = 0) -> [AXUIElement] {
  if depth > 80 { return [] }; return [node] + children(node).flatMap { descendants($0, depth: depth + 1) }
}
func output(_ node: AXUIElement) -> [String: String] {
 ["role":text(node,kAXRoleAttribute as CFString),"title":text(node,kAXTitleAttribute as CFString),"description":text(node,kAXDescriptionAttribute as CFString),"value":text(node,kAXValueAttribute as CFString),"enabled":String(attribute(node,kAXEnabledAttribute as CFString) as? Bool ?? false)]
}
guard AXIsProcessTrusted() else { fputs("Accessibility permission is unavailable\n",stderr);exit(2) }
let args=CommandLine.arguments
guard args.count>=3, let pid=Int32(args[1]) else {exit(2)}
let app=AXUIElementCreateApplication(pid)
let windows=attribute(app,kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
let nodes=windows.flatMap { descendants($0) }
if args[2]=="dump" {
 let data=try JSONSerialization.data(withJSONObject:nodes.map(output),options:[.prettyPrinted,.sortedKeys]);print(String(data:data,encoding:.utf8)!)
} else {
 guard args.count>=4 else {exit(2)}
 let label=args[3]
 guard let node=nodes.first(where: {n in
  let values=output(n)
  let roleMatches=args[2]=="press" ? values["role"]=="AXButton" : ["AXTextField","AXTextArea"].contains(values["role"] ?? "")
  return roleMatches && values["enabled"]=="true" && (values["title"]==label || values["description"]==label)
 }) else {fputs("Enabled visible control not found: \(label)\n",stderr);exit(3)}
 let result:AXError
 if args[2]=="press" {result=AXUIElementPerformAction(node,kAXPressAction as CFString)}
 else if args[2]=="set",args.count==5 {
  NSRunningApplication(processIdentifier:pid)?.activate(options:[])
  let focused=AXUIElementSetAttributeValue(node,kAXFocusedAttribute as CFString,kCFBooleanTrue)
  guard focused == .success else {fputs("Visible field could not receive focus\n",stderr);exit(4)}
  let selectDown=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true)!
  selectDown.flags = .maskCommand;selectDown.postToPid(pid)
  let selectUp=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false)!
  selectUp.flags = .maskCommand;selectUp.postToPid(pid)
  usleep(50000)
  let units=Array(args[4].utf16)
  let down=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true)!
  down.keyboardSetUnicodeString(stringLength:units.count,unicodeString:units)
  down.postToPid(pid)
  let up=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false)!
  up.keyboardSetUnicodeString(stringLength:units.count,unicodeString:units)
  up.postToPid(pid)
  result = .success
}
 else if args[2]=="paste", args.count==4 {
  // Plan 181 S5c1 transfer mode for multi-KiB artifacts (decision gate G-AX). The text arrives on stdin, never
  // in argv. It goes on the pasteboard, then select-all and paste are posted to the pid. The harness verifies
  // the value in the dump. Posting the text as bounded runs of key events was tried and rejected: the readback
  // differed from the input after a few hundred characters.
  let input=String(data:FileHandle.standardInput.readDataToEndOfFile(),encoding:.utf8) ?? ""
  let board=NSPasteboard.general
  board.clearContents()
  guard board.setString(input,forType:.string) else {fputs("Pasteboard write failed\n",stderr);exit(4)}
  NSRunningApplication(processIdentifier:pid)?.activate(options:[])
  let focused=AXUIElementSetAttributeValue(node,kAXFocusedAttribute as CFString,kCFBooleanTrue)
  guard focused == .success else {fputs("Visible field could not receive focus\n",stderr);exit(4)}
  func key(_ code:CGKeyCode) {
   for isDown in [true,false] {
    let event=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:isDown)!
    event.flags = .maskCommand;event.postToPid(pid)
   }
  }
  key(0)
  usleep(80000)
  key(9)
  usleep(300000)
  result = .success
}
 else {exit(2)}
 guard result == .success else {fputs("Accessibility action refused: \(result.rawValue)\n",stderr);exit(4)}
}
