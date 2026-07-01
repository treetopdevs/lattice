%% AtomVM Phase-0 browser spike realm.
%% Proves, in a real headless browser under COOP/COEP:
%%   C3  boot + ready beacon (constant run_script — no interpolation)
%%   C4  JS->BEAM->JS round-trip via Module.call + promise_resolve
%%       (the reply crosses as a STRUCTURED promise result; envelope bytes
%%        NEVER enter a run_script string => the security invariant holds)
%%   C6  JSON decoded AND encoded in BEAM (estdlib json) — raw string crosses
%%   path B probe: websocket:is_supported() proves the BEAM-owned socket exists
-module(spike).
-export([start/0]).

start() ->
    register(realm, self()),
    WsSupported = websocket:is_supported(),
    %% C3 ready beacon — a CONSTANT script (no data interpolated). Also stash the
    %% websocket-availability flag for the driver to read (path B evidence).
    emscripten:run_script(
        iolist_to_binary([
            <<"document.getElementById('app').setAttribute('data-ws-supported','">>,
            atom_to_list(WsSupported),
            <<"');">>,
            <<"document.getElementById('app').setAttribute('data-atomvm-ready','true');">>
        ]),
        [main_thread]
    ),
    loop(0).

loop(N) ->
    receive
        %% C4 + C6: Module.call('realm', WelcomeJson). Decode in BEAM, build a real
        %% hello, encode in BEAM, return it as the promise RESULT. No eval anywhere
        %% on the data path.
        {emscripten, {call, Promise, Msg}} ->
            Reply = handle_envelope(Msg),
            emscripten:promise_resolve(Promise, Reply),
            loop(N + 1);
        %% one-way cast: render via a CONSTANT script (no msg interpolation).
        {emscripten, {cast, _Msg}} ->
            emscripten:run_script(<<"window.__castCount=(window.__castCount||0)+1;">>, [
                main_thread, async
            ]),
            loop(N + 1);
        _Other ->
            loop(N)
    end.

%% C6: JSON in BEAM — decode a `welcome`, emit a real `hello` (Protocol.hello shape).
handle_envelope(Msg) ->
    try
        Decoded = json:decode(Msg),
        ClientId = maps:get(<<"client_id">>, Decoded, <<"unknown">>),
        Hello = #{
            <<"type">> => <<"hello">>,
            <<"client_id">> => ClientId,
            <<"identity">> => #{
                <<"surface">> => <<"atomvm-tab">>,
                <<"client_id">> => ClientId
            }
        },
        iolist_to_binary(json:encode(Hello))
    catch
        Class:Reason ->
            iolist_to_binary(io_lib:format("{\"type\":\"error\",\"reason\":\"~p:~p\"}", [Class, Reason]))
    end.
