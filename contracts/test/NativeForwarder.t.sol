// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../NativeForwarder.sol";

// ---------------------------------------------------------------------------
// Helper contracts
// ---------------------------------------------------------------------------

/// @dev A recipient that simply accepts native USDC (no callback logic).
contract AcceptingRecipient {
    uint256 public received;
    receive() external payable { received += msg.value; }
}

/// @dev A recipient whose receive() always reverts.
contract RejectingRecipient {
    receive() external payable { revert("reject"); }
}

/// @dev A recipient that attempts to re-enter NativeForwarder.send().
contract ReentrantRecipient {
    NativeForwarder public target;
    address public reentrantRecipient;
    bool public reentryAttempted;
    bool public reentrySuceeded;

    constructor(NativeForwarder _target) { target = _target; }

    function setReentrantRecipient(address r) external { reentrantRecipient = r; }

    receive() external payable {
        reentryAttempted = true;
        try target.send{value: msg.value / 2}(reentrantRecipient) {
            reentrySuceeded = true;
        } catch {
            reentrySuceeded = false;
        }
    }
}

/// @dev A recipient that consumes a lot of gas in its callback (gas-heavy callback).
contract GasHeavyRecipient {
    uint256 public counter;
    receive() external payable {
        for (uint256 i = 0; i < 100; i++) {
            counter++;
        }
    }
}

// ---------------------------------------------------------------------------
// Main test contract
// ---------------------------------------------------------------------------

contract NativeForwarderTest is Test {
    NativeForwarder public forwarder;
    AcceptingRecipient public acceptor;
    RejectingRecipient public rejecter;

    address public alice = makeAddr("alice");
    address public bob   = makeAddr("bob");
    address public carol = makeAddr("carol");

    /// @dev 1 USDC in native 18-decimal representation.
    uint256 constant ONE_USDC_NATIVE = 1e18;

    // -----------------------------------------------------------------------
    // ABI constants — verified with `cast keccak`
    // -----------------------------------------------------------------------

    /// @dev send(address) selector: keccak256("send(address)")[0..3]
    bytes4  constant SEND_SELECTOR = 0x3e58c58c;

    /// @dev Transferred(address indexed,address indexed,uint256) topic0.
    /// keccak256("Transferred(address,address,uint256)")
    bytes32 constant TRANSFERRED_TOPIC =
        0xd1ba4ac2e2a11b5101f6cb4d978f514a155b421e8ec396d2d9abaf0bb02917ee;

    function setUp() public {
        forwarder = new NativeForwarder();
        acceptor  = new AcceptingRecipient();
        rejecter  = new RejectingRecipient();

        vm.deal(alice, 100 * ONE_USDC_NATIVE);
        vm.deal(bob,   100 * ONE_USDC_NATIVE);
        vm.deal(carol, 100 * ONE_USDC_NATIVE);
    }

    // -----------------------------------------------------------------------
    // ABI constants — on-chain verification
    // -----------------------------------------------------------------------

    /**
     * @notice Verify that the send(address) function selector in the live ABI
     *         matches the constant SEND_SELECTOR declared above and used by the
     *         JavaScript frontend (buildSendCalldata).
     *
     * This test exercises an actual send() call encoded with the selector, not
     * abi.encodeWithSignature, to confirm the live dispatch table matches.
     */
    function test_sendSelector_matchesABIDispatch() public {
        uint256 amount = ONE_USDC_NATIVE;
        address recipient = address(acceptor);

        // Build calldata exactly as the JS frontend does:
        // selector (4 bytes) || left-padded recipient (32 bytes)
        bytes memory calldata_ = abi.encodePacked(
            SEND_SELECTOR,
            bytes32(uint256(uint160(recipient)))
        );

        vm.deal(alice, amount);
        vm.prank(alice);
        (bool ok, ) = address(forwarder).call{value: amount}(calldata_);
        assertTrue(ok, "call with JS-generated calldata must succeed");
        assertEq(acceptor.received(), amount, "recipient must have received the exact amount");
        assertEq(address(forwarder).balance, 0, "forwarder must not retain balance");
    }

    /**
     * @notice Verify the Transferred event topic0 matches TRANSFERRED_TOPIC.
     *
     * This test:
     *   1. Records logs emitted by a real send() call on the local EVM.
     *   2. Asserts that the first topic of the emitted log equals TRANSFERRED_TOPIC.
     *   3. Decodes sender, recipient, and amount from topics and data.
     *   4. Asserts they match the call arguments.
     *
     * This directly validates what the JS verifyTransferredEvent() function
     * will observe on-chain after a real transaction.
     */
    function test_transferredEventTopic_andDecode() public {
        uint256 amount = 2 * ONE_USDC_NATIVE;
        address recipient = address(acceptor);

        // Record all emitted logs for this call.
        vm.recordLogs();
        vm.prank(alice);
        forwarder.send{value: amount}(recipient);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "exactly one log must be emitted per send()");

        Vm.Log memory log = logs[0];

        // topic0 must equal TRANSFERRED_TOPIC.
        assertEq(
            log.topics[0],
            TRANSFERRED_TOPIC,
            "topic0 must match keccak256(Transferred(address,address,uint256))"
        );

        // Decode indexed topics: topics[1] = sender, topics[2] = recipient.
        address logSender    = address(uint160(uint256(log.topics[1])));
        address logRecipient = address(uint160(uint256(log.topics[2])));
        assertEq(logSender,    alice,     "log sender must be alice");
        assertEq(logRecipient, recipient, "log recipient must match");

        // Decode non-indexed amount from data.
        uint256 logAmount = abi.decode(log.data, (uint256));
        assertEq(logAmount, amount, "log amount must match msg.value");
    }

    /**
     * @notice End-to-end: JS-generated calldata → local EVM execution → event decode.
     *
     * Simulates the full flow the frontend performs:
     *   1. Build calldata with SEND_SELECTOR + ABI-encoded recipient.
     *   2. Submit via low-level call (as eth_sendTransaction does).
     *   3. Read the emitted log.
     *   4. Verify topic0 == TRANSFERRED_TOPIC.
     *   5. Decode sender/recipient/amount and assert they match the inputs.
     */
    function test_e2e_jsCalldata_toEventDecode() public {
        uint256 amount    = 3 * ONE_USDC_NATIVE;
        address recipient = bob;

        // Record bob's balance before the transfer (setUp gave bob 100 USDC).
        uint256 bobBalanceBefore = bob.balance;

        // Step 1: build calldata as the JS frontend would.
        bytes memory calldata_ = abi.encodePacked(
            SEND_SELECTOR,
            bytes32(uint256(uint160(recipient)))
        );

        // Step 2: record logs and execute via raw call.
        vm.recordLogs();
        vm.deal(alice, amount);
        vm.prank(alice);
        (bool ok, ) = address(forwarder).call{value: amount}(calldata_);
        assertTrue(ok, "call must succeed");

        // Step 3: get the emitted log.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "exactly one log must be emitted");
        Vm.Log memory log = logs[0];

        // Step 4: topic0 == TRANSFERRED_TOPIC.
        assertEq(log.topics[0], TRANSFERRED_TOPIC, "topic0 must match TRANSFERRED_TOPIC");

        // Step 5: decode and assert.
        address logSender    = address(uint160(uint256(log.topics[1])));
        address logRecipient = address(uint160(uint256(log.topics[2])));
        uint256 logAmount    = abi.decode(log.data, (uint256));

        assertEq(logSender,    alice,     "decoded sender must be alice");
        assertEq(logRecipient, recipient, "decoded recipient must be bob");
        assertEq(logAmount,    amount,    "decoded amount must match");
        // Check balance delta (bob had setUp funds before).
        assertEq(
            bob.balance - bobBalanceBefore,
            amount,
            "recipient balance must reflect forwarded amount"
        );
    }

    /**
     * @notice Verify that wrong selector bytes cause the call to revert.
     *
     * The old (incorrect) selector 0x6d8fcb97 must not dispatch to send().
     * This confirms the selector constant is load-bearing, not just decorative.
     */
    function test_wrongSelector_reverts() public {
        bytes4 wrongSelector = 0x6d8fcb97; // previously used incorrect selector
        bytes memory calldata_ = abi.encodePacked(
            wrongSelector,
            bytes32(uint256(uint160(address(acceptor))))
        );
        vm.deal(alice, ONE_USDC_NATIVE);
        vm.prank(alice);
        (bool ok, ) = address(forwarder).call{value: ONE_USDC_NATIVE}(calldata_);
        assertFalse(ok, "wrong selector must not dispatch to send()");
    }

    // -----------------------------------------------------------------------
    // Happy path — exact amount and event
    // -----------------------------------------------------------------------

    function test_send_forwardsExactAmount() public {
        uint256 amount = 5 * ONE_USDC_NATIVE;
        uint256 balBefore = address(acceptor).balance;

        vm.prank(alice);
        forwarder.send{value: amount}(address(acceptor));

        assertEq(address(acceptor).balance - balBefore, amount, "recipient balance mismatch");
        assertEq(address(forwarder).balance, 0, "forwarder must not retain balance");
    }

    function test_send_emitsTransferredEvent() public {
        uint256 amount = 2 * ONE_USDC_NATIVE;

        vm.expectEmit(true, true, false, true);
        emit NativeForwarder.Transferred(alice, address(acceptor), amount);

        vm.prank(alice);
        forwarder.send{value: amount}(address(acceptor));
    }

    function test_send_toEOA() public {
        uint256 amount = ONE_USDC_NATIVE;
        uint256 balBefore = bob.balance;

        vm.prank(alice);
        forwarder.send{value: amount}(bob);

        assertEq(bob.balance - balBefore, amount);
        assertEq(address(forwarder).balance, 0);
    }

    // -----------------------------------------------------------------------
    // Revert paths
    // -----------------------------------------------------------------------

    function test_send_revertsOnZeroRecipient() public {
        vm.prank(alice);
        vm.expectRevert(NativeForwarder.ZeroRecipient.selector);
        forwarder.send{value: ONE_USDC_NATIVE}(address(0));
    }

    function test_send_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(NativeForwarder.ZeroAmount.selector);
        forwarder.send{value: 0}(address(acceptor));
    }

    function test_send_revertsOnSelfRecipient() public {
        vm.prank(alice);
        vm.expectRevert(NativeForwarder.SelfRecipient.selector);
        forwarder.send{value: ONE_USDC_NATIVE}(address(forwarder));
    }

    function test_send_revertsWhenRecipientReverts() public {
        vm.prank(alice);
        vm.expectRevert(NativeForwarder.ForwardFailed.selector);
        forwarder.send{value: ONE_USDC_NATIVE}(address(rejecter));
    }

    // -----------------------------------------------------------------------
    // Reentrancy guard
    // -----------------------------------------------------------------------

    function test_send_nonReentrantGuardBlocks() public {
        ReentrantRecipient reentrant = new ReentrantRecipient(forwarder);
        AcceptingRecipient secondRecipient = new AcceptingRecipient();
        reentrant.setReentrantRecipient(address(secondRecipient));

        vm.deal(address(reentrant), 10 * ONE_USDC_NATIVE);

        vm.prank(alice);
        forwarder.send{value: 2 * ONE_USDC_NATIVE}(address(reentrant));

        assertTrue(reentrant.reentryAttempted(), "re-entry was not attempted");
        assertFalse(reentrant.reentrySuceeded(), "re-entry must not succeed");
        assertEq(address(forwarder).balance, 0, "forwarder must not retain balance after reentrant attempt");
    }

    // -----------------------------------------------------------------------
    // Multiple callers
    // -----------------------------------------------------------------------

    function test_send_multipleCallers() public {
        AcceptingRecipient r1 = new AcceptingRecipient();
        AcceptingRecipient r2 = new AcceptingRecipient();

        vm.prank(alice);
        forwarder.send{value: 3 * ONE_USDC_NATIVE}(address(r1));

        vm.prank(bob);
        forwarder.send{value: 7 * ONE_USDC_NATIVE}(address(r2));

        vm.prank(carol);
        forwarder.send{value: ONE_USDC_NATIVE}(address(r1));

        assertEq(r1.received(), 4 * ONE_USDC_NATIVE, "r1 total mismatch");
        assertEq(r2.received(), 7 * ONE_USDC_NATIVE, "r2 total mismatch");
        assertEq(address(forwarder).balance, 0, "forwarder must not retain balance");
    }

    // -----------------------------------------------------------------------
    // Fuzz
    // -----------------------------------------------------------------------

    function testFuzz_send_forwardsExactAmount(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 1, 50 * ONE_USDC_NATIVE);

        AcceptingRecipient r = new AcceptingRecipient();
        vm.deal(alice, amount);

        vm.prank(alice);
        forwarder.send{value: amount}(address(r));

        assertEq(r.received(), amount, "fuzz: forwarded amount mismatch");
        assertEq(address(forwarder).balance, 0, "fuzz: forwarder must not retain balance");
    }

    // -----------------------------------------------------------------------
    // No unintended privileged operations
    // -----------------------------------------------------------------------

    function test_noOwner_noAdminFunction() public {
        (bool success, ) = address(forwarder).call(abi.encodeWithSignature("owner()"));
        assertFalse(success, "unexpected owner() function exists");
    }

    function test_noUpgrade_noProxyPattern() public {
        (bool success, ) = address(forwarder).call(abi.encodeWithSignature("upgradeTo(address)", alice));
        assertFalse(success, "unexpected upgradeTo() function exists");
    }

    function test_noWithdraw() public {
        (bool success, ) = address(forwarder).call(abi.encodeWithSignature("withdraw()"));
        assertFalse(success, "unexpected withdraw() function exists");
    }

    // -----------------------------------------------------------------------
    // receive() guard
    // -----------------------------------------------------------------------

    function test_receive_rejectsPlainTransfer() public {
        vm.prank(alice);
        (bool ok, ) = address(forwarder).call{value: ONE_USDC_NATIVE}("");
        assertFalse(ok, "plain transfer to forwarder must be rejected");
        assertEq(address(forwarder).balance, 0, "forwarder must not hold balance after rejected plain send");
    }

    // -----------------------------------------------------------------------
    // Gas-heavy callback
    // -----------------------------------------------------------------------

    function test_send_gasHeavyCallbackSucceeds() public {
        GasHeavyRecipient heavy = new GasHeavyRecipient();
        uint256 amount = ONE_USDC_NATIVE;

        vm.prank(alice);
        forwarder.send{value: amount}(address(heavy));

        assertEq(address(heavy).balance, amount);
        assertEq(address(forwarder).balance, 0);
    }

    // -----------------------------------------------------------------------
    // Minimum amount
    // -----------------------------------------------------------------------

    function test_send_oneWei() public {
        AcceptingRecipient r = new AcceptingRecipient();
        vm.deal(alice, 1);

        vm.prank(alice);
        forwarder.send{value: 1}(address(r));

        assertEq(r.received(), 1);
        assertEq(address(forwarder).balance, 0);
    }

    // -----------------------------------------------------------------------
    // JS buildSendCalldata() integration — #8
    //
    // The calldata bytes below are the LITERAL OUTPUT of the JavaScript
    // buildSendCalldata() function run in the sandbox:
    //
    //   import { buildSendCalldata } from './src/transfer.js';
    //   buildSendCalldata('0x1111111111111111111111111111111111111111')
    //   // => '0x3e58c58c0000000000000000000000001111111111111111111111111111111111111111'
    //
    // The hex is copied verbatim — it is NOT reconstructed in Solidity.
    // This test proves that the JS function produces ABI-correct calldata that
    // the EVM dispatches correctly and that emits the expected Transferred event.
    //
    // Distinction from test_e2e_jsCalldata_toEventDecode (which builds calldata
    // in Solidity using abi.encodePacked): this test uses the ACTUAL JS output.
    // -----------------------------------------------------------------------

    function test_jsOutput_buildSendCalldata_executes_and_emits() public {
        // Literal output of JS buildSendCalldata('0x1111...1111')
        // obtained by running the function in the sandbox (see comment above).
        bytes memory jsCalldata = hex"3e58c58c0000000000000000000000001111111111111111111111111111111111111111";

        address recipient = address(0x1111111111111111111111111111111111111111);
        uint256 amount    = ONE_USDC_NATIVE;

        // Confirm the first 4 bytes equal SEND_SELECTOR.
        bytes4 selector;
        assembly { selector := mload(add(jsCalldata, 32)) }
        assertEq(selector, SEND_SELECTOR, "first 4 bytes must equal SEND_SELECTOR");

        // Confirm the address word decodes to recipient.
        address decodedRecipient;
        assembly { decodedRecipient := mload(add(jsCalldata, 36)) }
        assertEq(decodedRecipient, recipient, "ABI word must decode to recipient");

        // Execute on local EVM with the JS-generated calldata.
        vm.deal(alice, amount);
        vm.recordLogs();
        vm.prank(alice);
        (bool ok, ) = address(forwarder).call{value: amount}(jsCalldata);
        assertTrue(ok, "call with JS calldata must succeed");

        // Verify the Transferred event was emitted with correct values.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found = false;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(forwarder) &&
                logs[i].topics.length == 3 &&
                logs[i].topics[0] == TRANSFERRED_TOPIC
            ) {
                address logSender    = address(uint160(uint256(logs[i].topics[1])));
                address logRecipient = address(uint160(uint256(logs[i].topics[2])));
                uint256 logAmount    = abi.decode(logs[i].data, (uint256));

                assertEq(logSender,    alice,     "event sender must be alice");
                assertEq(logRecipient, recipient, "event recipient must match JS calldata");
                assertEq(logAmount,    amount,    "event amount must match");
                found = true;
                break;
            }
        }
        assertTrue(found, "Transferred event not found in logs");

        // Forwarder must hold no balance after forwarding.
        assertEq(address(forwarder).balance, 0, "forwarder must not hold balance");
        // Recipient received exact amount.
        assertEq(recipient.balance, amount, "recipient balance must equal amount");
    }
}
