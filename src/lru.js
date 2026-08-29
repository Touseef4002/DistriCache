export class Node {
  /** @param {string|null} key @param {string|null} value */
  constructor(key = null, value = null) {
    this.key = key;
    this.value = value;
    this.expiresAt = null;
    this.prev = null;
    this.next = null;
  }
}

export class DoublyLinkedList {
  constructor() {
    this.head = new Node();
    this.tail = new Node();
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.length = 0;
  }

  /** @param {Node} node */
  addToFront(node) {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next.prev = node;
    this.head.next = node;
    this.length++;
  }

  /** @param {Node} node */
  remove(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
    this.length--;
  }

  /** @param {Node} node */
  moveToFront(node) {
    this.remove(node);
    this.addToFront(node);
  }

  /** @returns {Node|null} */
  removeLast() {
    if (this.length === 0) return null;
    const lruNode = this.tail.prev;
    this.remove(lruNode);
    return lruNode;
  }

  /** @returns {Node|null} */
  peekFront() {
    return this.length === 0 ? null : this.head.next;
  }

  /** @returns {Node|null} */
  peekLast() {
    return this.length === 0 ? null : this.tail.prev;
  }
}
