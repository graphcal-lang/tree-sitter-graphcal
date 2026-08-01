/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Precedence levels (lowest to highest), matching the Graphcal parser.
const PREC = {
  CONVERT: 1,    // ->
  OR: 2,         // ||
  AND: 3,        // &&
  COMPARE: 4,    // == != < > <= >=
  ADD: 5,        // + -
  MUL: 6,        // * /
  UNARY: 7,      // - !
  POWER: 8,      // ^
  POSTFIX: 9,    // . []
  CALL: 10,      // fn(...)
  // Nat arithmetic lives only in type-level slots. Its elevated precedence
  // keeps `M * N + 1` alive as a Nat argument instead of prematurely reducing
  // `M * N` as a dimension expression inside a generic argument.
  NAT_ADD: 11,
  NAT_MUL: 12,
};

module.exports = grammar({
  name: "graphcal",

  extras: $ => [
    /\s/,
    $.line_comment,
  ],

  // These spellings are identifiers unless the external scanner sees both
  // the precise parser state and the delimiter that commits to their special
  // production. The sentinel opts out during error recovery.
  externals: $ => [
    $._scan_keyword,
    $._unfold_keyword,
    $._range_keyword,
    $._linspace_keyword,
    $._step_keyword,
    $._points_keyword,
    $._fin_keyword,
    $._key_keyword,
    $._fin_key_keyword,
    $._floor_key_keyword,
    $._ceil_key_keyword,
    $._nearest_key_keyword,
    $._contextual_keyword_error_sentinel,
  ],

  word: $ => $.identifier,

  conflicts: $ => [
    // The first slot of a multi_decl is indistinguishable from a
    // param/node/const-node declaration up through the end of the type
    // annotation. The disambiguator is the trailing `,`.
    [$.multi_decl_kind, $.node_declaration],
    [$.multi_decl_kind, $.param_declaration],
    // `IDENT . IDENT` after `import` / `include` could either continue
    // a module_path or finish the path and stand at the start of a
    // `. { ... }` brace-list tail. The disambiguator (1-token lookahead
    // past the `.`) requires GLR — `IDENT` continues, `{` starts a tail.
    [$.module_path],
    // `@<name>` could be the start of a bare `graph_ref` (with field
    // projections handled by `field_access`) or an `inline_dag_call`
    // (with multi-segment path before `(args)`). The disambiguator is
    // whether `(args).<out>` eventually follows the path.
    [$.graph_ref, $.inline_dag_call],
    // `IDENT . IDENT` could be either a `qualified_variant` (variant
    // ref or qualified const ref) or a `_primary_expr` (the leading
    // `IDENT`) followed by a postfix `field_access`. The name resolver
    // distinguishes them (variant when LHS is a known index, otherwise
    // a qualified const). Both parses are accepted by the GLR parser
    // and any downstream consumer reads `qualified_variant` when present.
    [$.ident_path, $.qualified_variant],
    [$.ident_path, $.qualified_variant, $.fn_call, $.struct_construction],
    // `IDENT < …` in expression position is either a comparison (reduce
    // the `IDENT` to `ident_path`) or the start of a turbofish generic
    // argument list (`Vec3<Length, Eci>(x: …)`, `f<Dimensionless>(x)`).
    // The GLR parser keeps both alive; the turbofish branch carries
    // dynamic precedence so it wins when both parses complete (the
    // reference grammar's comparisons are non-chaining, so the chained
    // `(a < b) > (c)` reading is never the intended one).
    [$.ident_path, $.fn_call, $.struct_construction],
    // Keep both parses alive after a unit term followed by `*` or `/`.
    // The next token distinguishes a compound unit (`m / s`) from
    // quantity arithmetic (`1.0 m / 2.0 s`).
    [$.unit_expr],
  ],

  rules: {
    source_file: $ => repeat($._declaration),

    // ---------------------------------------------------------------
    // Declarations
    // ---------------------------------------------------------------

    // Visibility annotation: `pub` or `pub(bind)`.
    // `bind` is a contextual keyword parsed only inside the parens after `pub`.
    visibility: $ => seq("pub", optional(seq("(", "bind", ")"))),

    _declaration: $ => choice(
      $.multi_decl,
      $.param_declaration,
      $.node_declaration,
      $.dimension_declaration,
      $.unit_declaration,
      $.type_declaration,

      $.index_declaration,
      $.plugin_import_declaration,
      $.import_declaration,
      $.include_declaration,
      $.dag_declaration,
      $.assert_declaration,
      $.plot_declaration,
      $.figure_declaration,
      $.layer_declaration,
    ),

    // #[name] or #[name(arg1, arg2)] or #[name(Index.Variant, (A.X, B.Y))]
    attribute: $ => seq(
      "#",
      "[",
      field("name", $.identifier),
      optional(seq(
        "(",
        optional(seq(
          $._attribute_arg,
          repeat(seq(",", $._attribute_arg)),
          optional(","),
        )),
        ")",
      )),
      "]",
    ),

    // An attribute argument: a path, a `#N` Fin position, or a group.
    _attribute_arg: $ => choice(
      $.attribute_path,
      $.attribute_finite_position,
      $.attribute_group,
    ),

    // Positional key for a Fin axis, matching table slice labels.
    attribute_finite_position: $ => seq("#", $.nat_literal),

    attribute_path: $ => seq(
      $.identifier,
      repeat(seq(".", $.identifier)),
    ),

    attribute_group: $ => seq(
      "(",
      $._attribute_arg,
      repeat(seq(",", $._attribute_arg)),
      optional(","),
      ")",
    ),

    // param dry_mass: Mass = 1200 kg;
    // param dry_mass: Mass;  (required param, no default)
    param_declaration: $ => seq(
      repeat($.attribute),
      optional($.visibility),
      "param",
      field("name", $.identifier),
      optional(seq(":", field("type", $.type_expr))),
      optional(seq("=", field("value", $._expr))),
      ";",
    ),

    // node v_exhaust: Velocity = @isp * @g0;
    // const node g0: Acceleration = 9.80665 m/s^2;
    node_declaration: $ => seq(
      repeat($.attribute),
      optional($.visibility),
      optional("const"),
      "node",
      field("name", $.identifier),
      optional(seq(":", field("type", $.type_expr))),
      "=",
      field("value", $._expr),
      ";",
    ),

    // Multi-declaration (issue #481): introduce N parallel
    // param/node/const-node declarations from a single table literal.
    // Attributes are forbidden; visibility (`pub` / `pub(bind)`) attaches
    // per slot, with the leading prefix applying to the first slot.
    //
    //     pub node a: T[I], const node b: U[I]
    //       = table[I, (_, _)] {
    //           : _, _;
    //           A: 1, 2;
    //       };
    multi_decl: $ => seq(
      field("slot", $.multi_decl_slot),
      ",",
      field("slot", $.multi_decl_slot),
      repeat(seq(",", field("slot", $.multi_decl_slot))),
      "=",
      field("init", $.multi_table_expr),
      ";",
    ),

    multi_decl_slot: $ => seq(
      optional(field("visibility", $.visibility)),
      field("kind", $.multi_decl_kind),
      field("name", $.identifier),
      ":",
      field("type", $.type_expr),
    ),

    multi_decl_kind: $ => choice(
      "param",
      "node",
      seq("const", "node"),
    ),

    multi_table_expr: $ => seq(
      "table",
      "[",
      field("shared_axis", choice($.ident_path, $.finite_table_index)),
      repeat(seq(",", field("shared_axis", choice($.ident_path, $.finite_table_index)))),
      ",",
      field("slot_tuple", $.slot_tuple),
      "]",
      "{",
      $.multi_table_body,
      "}",
    ),

    slot_tuple: $ => seq(
      "(",
      field("entry", $.slot_axis_entry),
      repeat(seq(",", field("entry", $.slot_axis_entry))),
      optional(","),
      ")",
    ),

    slot_axis_entry: $ => choice("_", $.ident_path),

    multi_table_body: $ => choice(
      repeat1($.multi_slice_section),
      $.multi_single,
    ),

    multi_slice_section: $ => seq(
      "[",
      $.table_slice_label,
      repeat(seq(",", $.table_slice_label)),
      "]",
      $.multi_single,
    ),

    multi_single: $ => seq(
      $.multi_header_row,
      repeat1($.multi_data_row),
    ),

    multi_header_row: $ => seq(
      ":",
      field("cell", $.multi_header_cell),
      repeat(seq(",", field("cell", $.multi_header_cell))),
      ";",
    ),

    multi_header_cell: $ => choice(
      "_",
      $.qualified_variant,
    ),

    multi_data_row: $ => seq(
      optional(seq(field("row_label", $.identifier), ":")),
      field("value", $._expr),
      repeat(seq(",", field("value", $._expr))),
      ";",
    ),

    // base dim Length;
    // dim D;                            -- required dim (bound via include)
    // dim Velocity = Length / Time;
    dimension_declaration: $ => seq(
      optional($.visibility),
      optional("base"),
      "dim",
      field("name", $.identifier),
      optional(seq("=", field("definition", $.dim_expr))),
      ";",
    ),

    // base unit m: Length;                 -- base unit (no body)
    // unit km: Length = 1000 m;             -- derived unit
    // const unit hr: Time = 3600 s;         -- compile-time-only unit
    unit_declaration: $ => choice(
      seq(
        optional($.visibility),
        "base",
        "unit",
        field("name", $.identifier),
        ":",
        field("dimension", $.dim_expr),
        ";",
      ),
      seq(
        optional($.visibility),
        optional("const"),
        "unit",
        field("name", $.identifier),
        ":",
        field("dimension", $.dim_expr),
        "=",
        field("definition", $.unit_def),
        ";",
      ),
    ),

    // Every `type T { … }` is an n-variant tagged union. Record-
    // shaped types are written as a single-variant union whose sole
    // constructor's name matches the type's name:
    //   type Position { Position(x: Length, y: Length) }
    // A unit marker:
    //   type Eci { Eci }
    // A required type stub:
    //   type Element;
    // A multi-variant union:
    //   type Maneuver {
    //     Impulsive(delta_v: Velocity),
    //     LowThrust(thrust: Force, duration: Time),
    //     Coast,
    //   }
    type_declaration: $ => seq(
      repeat($.attribute),
      optional($.visibility),
      "type",
      field("name", $.identifier),
      optional(field("generics", $.generic_params)),
      choice(
        seq("{", $.constructor_list, "}"),
        ";",
      ),
    ),

    field_declaration: $ => seq(
      field("name", $.identifier),
      ":",
      field("type", $.type_expr),
    ),

    constructor_list: $ => seq(
      $.constructor_declaration,
      repeat(seq(",", $.constructor_declaration)),
      optional(","),
    ),

    // A constructor is either a bare unit constructor or uses the one
    // canonical parenthesized payload form.
    constructor_declaration: $ => seq(
      field("name", $.identifier),
      optional(seq(
        "(",
        optional(seq(
          $.field_declaration,
          repeat(seq(",", $.field_declaration)),
          optional(","),
        )),
        ")",
      )),
    ),

    // index Maneuver = { Departure, Correction, Insertion };
    // index TimeStep = range(0.0 s, 1.0 s, step: 0.1 s);
    // index Samples = linspace(0.0 s, 1.0 s, points: 11);
    // index Foo;  (required named)
    // index Foo: Time;  (required coordinate)
    index_declaration: $ => choice(
      // Named index: index Maneuver = { Departure, Correction, Insertion };
      seq(
        optional($.visibility),
        "index",
        field("name", $.identifier),
        "=",
        "{",
        $.variant,
        repeat(seq(",", $.variant)),
        optional(","),
        "}",
        ";",
      ),
      // Exact-step coordinate index.
      seq(
        optional($.visibility),
        "index",
        field("name", $.identifier),
        "=",
        alias($._range_keyword, "range"),
        "(",
        field("start", $._expr),
        ",",
        field("end", $._expr),
        ",",
        alias($._step_keyword, "step"),
        ":",
        field("step", $._expr),
        ")",
        ";",
      ),
      // Exact-count coordinate index.
      seq(
        optional($.visibility),
        "index",
        field("name", $.identifier),
        "=",
        alias($._linspace_keyword, "linspace"),
        "(",
        field("start", $._expr),
        ",",
        field("end", $._expr),
        ",",
        alias($._points_keyword, "points"),
        ":",
        field("points", $._nat_expr),
        ")",
        ";",
      ),
      // Required named: index Foo;
      seq(optional($.visibility), "index", field("name", $.identifier), ";"),
      // Required coordinate: index Foo: Time;
      seq(
        optional($.visibility),
        "index",
        field("name", $.identifier),
        ":",
        field("dimension", $.dim_expr),
        ";",
      ),
    ),

    variant: $ => $.identifier,


    generic_params: $ => seq(
      "<",
      $.generic_param,
      repeat(seq(",", $.generic_param)),
      optional(","),
      ">",
    ),

    generic_param: $ => seq(
      field("name", $.identifier),
      ":",
      field("constraint", $.generic_constraint),
      optional(seq("=", field("default", $.generic_arg))),
    ),

    generic_constraint: $ => choice("Dim", "Index", "Nat", "Type"),


    // import nasa.rocket;                                 -- bare module import
    // import nasa.rocket as r;                            -- module import with alias
    // import nasa.rocket.{ Orbit, compute_thrust as ct };  -- brace-list selector
    //
    // `pub import ...` re-exports. The brace-list and `as` forms are
    // mutually exclusive. All paths are dot-separated and absolute from
    // the package root; no file-path strings, no `..`, no `/`.
    import_declaration: $ => seq(
      repeat($.attribute),
      optional($.visibility),
      "import",
      field("path", $.module_path),
      optional($._import_tail),
      ";",
    ),

    _import_tail: $ => choice(
      seq("as", field("alias", $.identifier)),
      $.brace_import_list,
    ),

    // import plugin "plugins/coolprop.wasm" as fluids {
    //     fn density(p: Pressure, t: Temperature) -> Density;
    //     fn smooth<D: Dim, I: Index>(xs: D[I], window: Dimensionless) -> D[I];
    // }
    //
    // Extern-function declarations (issue graphcal#943, Phase A). The
    // alias is mandatory — extern functions are only callable qualified
    // through it — and there is no `pub` form and no trailing `;`.
    //
    // `plugin` is a contextual keyword in the reference parser: `import`
    // selects this form only when followed by the identifier `plugin`
    // *and* a string literal, so `import plugin.tools as t;` stays an
    // ordinary module import. The keyword slot is therefore spelled
    // `alias($.identifier, "plugin")` rather than a literal token —
    // a literal would win keyword extraction over `identifier` after
    // `import` and break module paths whose first segment is `plugin`.
    // The string literal in second position is what disambiguates.
    plugin_import_declaration: $ => seq(
      "import",
      alias($.identifier, "plugin"),
      field("path", $.string_literal),
      "as",
      field("alias", $.identifier),
      "{",
      repeat($.extern_fn_declaration),
      "}",
    ),

    // fn geometric_mean<D1: Dim, D2: Dim>(x: D1, y: D2) -> D1^(1/2) * D2^(1/2);
    extern_fn_declaration: $ => seq(
      "fn",
      field("name", $.identifier),
      optional($.extern_generic_binders),
      "(",
      optional(seq(
        $.extern_fn_param,
        repeat(seq(",", $.extern_fn_param)),
        optional(","),
      )),
      ")",
      "->",
      field("result", $.type_expr),
      ";",
    ),

    // Generic binders: <D: Dim>, <D1: Dim, D2: Dim>, <D: Dim, I: Index>
    //
    // Same `name: constraint` form as `generic_params`, restricted to
    // `Dim` and `Index` (no `Nat`/`Type`, no defaults). The constraint is
    // aliased to `generic_constraint` so it gets the same node name (and
    // highlighting) as constraints in `type` declarations.
    extern_generic_binders: $ => seq(
      "<",
      $.extern_generic_binder,
      repeat(seq(",", $.extern_generic_binder)),
      optional(","),
      ">",
    ),

    extern_generic_binder: $ => seq(
      field("name", $.identifier),
      ":",
      field("constraint", alias(choice("Dim", "Index"), $.generic_constraint)),
    ),

    extern_fn_param: $ => seq(
      field("name", $.identifier),
      ":",
      field("type", $.type_expr),
    ),

    brace_import_list: $ => seq(
      ".",
      "{",
      optional(seq(
        $.import_item,
        repeat(seq(",", $.import_item)),
        optional(","),
      )),
      "}",
    ),

    // include nasa.rocket.compute_thrust(args);                       -- bare include
    // include nasa.rocket.compute_thrust(args) as ct;                 -- include with alias
    // include nasa.rocket.compute_thrust(args).{ thrust };             -- brace-list output selector
    //
    // The `(args)` parameter binding list is mandatory (may be empty).
    // The brace-list and `as` forms are mutually exclusive.
    include_declaration: $ => seq(
      repeat($.attribute),
      optional($.visibility),
      "include",
      field("path", $.module_path),
      field("param_bindings", $.include_param_bindings),
      optional($._include_tail),
      ";",
    ),

    _include_tail: $ => choice(
      seq("as", field("alias", $.identifier)),
      $.brace_include_list,
    ),

    brace_include_list: $ => seq(
      ".",
      "{",
      optional(seq(
        $.include_item,
        repeat(seq(",", $.include_item)),
        optional(","),
      )),
      "}",
    ),

    // Param bindings for include instantiation: (name: expr, ...)
    // The list may be empty: `include foo();` is valid (matches the
    // EBNF `[ include_param_binding, { ",", ... }, [ "," ] ]`).
    include_param_bindings: $ => seq(
      "(",
      optional(seq(
        $.include_param_binding,
        repeat(seq(",", $.include_param_binding)),
        optional(","),
      )),
      ")",
    ),

    // A single param binding in include: name: expr
    include_param_binding: $ => seq(
      field("name", $.identifier),
      ":",
      field("value", $._expr),
    ),

    // dag name { declarations... }
    dag_declaration: $ => seq(
      repeat($.attribute),
      optional($.visibility),
      "dag",
      field("name", $.identifier),
      "{",
      repeat($._declaration),
      "}",
    ),

    // Module path: dot-separated, absolute from a package root.
    // The leading segment is the package name (real or virtual); the
    // remaining segments walk the package's module tree (directories,
    // files, and inline `dag` declarations).
    //
    // The grammar relies on a `[$.module_path]` conflict declaration
    // (see `conflicts`) so the GLR parser can keep both "continue the
    // path" and "stop the path here" branches alive when it sees `.`
    // after an identifier — disambiguating once it sees the next token
    // (`IDENT` continues the path; `{` starts an import/include
    // brace-list tail).
    module_path: $ => seq(
      $.identifier,
      repeat(seq(".", $.identifier)),
    ),

    // Source identifier path preserved before semantic namespace resolution.
    //
    // Deliberately *not* left-associative: at `IDENT` with lookahead `<`
    // the reduce to `ident_path` (comparison reading) and the shift into
    // a fn_call/struct_construction turbofish must stay an unresolved
    // conflict so the GLR parser forks (see `conflicts`). With prec.left
    // the tie at PREC.CALL was resolved statically in favor of the
    // reduce, killing `Vec3<Length, Eci>(x: ...)` in expression position.
    ident_path: $ => prec(PREC.CALL, seq(
      $.identifier,
      repeat(seq(".", $.identifier)),
    )),

    // Import item with optional namespace marker, alias, and optional
    // `pub` re-export marker: name, type Name, pub type Name as Alias.
    import_item: $ => seq(
      repeat($.attribute),
      optional("pub"),
      optional("type"),
      field("name", $.identifier),
      optional(seq("as", field("alias", $.identifier))),
    ),

    // Include item with optional alias and optional `pub` re-export
    // marker: name, name as alias, pub name, pub name as alias.
    include_item: $ => seq(
      repeat($.attribute),
      optional("pub"),
      field("name", $.identifier),
      optional(seq("as", field("alias", $.identifier))),
    ),

    // assert velocity_in_range = @velocity < @max_velocity;
    // assert mass_approx = @mass ~= 100.0 kg +/- 1.0 kg;
    // assert relative = @x ~= 50.0 +/- abs(50.0) * 0.05;
    assert_declaration: $ => seq(
      repeat($.attribute),
      optional($.visibility),
      "assert",
      field("name", $.identifier),
      "=",
      field("body", $.assert_body),
      ";",
    ),

    // plot mass_vs_dv = {
    //     mark: point,
    //     encode: {
    //         x: for m: Maneuver { @delta_v[m] },
    //         y: for m: Maneuver { @spacecraft_mass[m] },
    //     },
    //     title: "Spacecraft Mass vs Delta-V",
    // };
    plot_declaration: $ => seq(
      repeat($.attribute),
      optional($.visibility),
      "plot",
      field("name", $.identifier),
      "=",
      "{",
      optional(seq(
        $._plot_body_field,
        repeat(seq(",", $._plot_body_field)),
        optional(","),
      )),
      "}",
      ";",
    ),

    _plot_body_field: $ => choice(
      $.mark_field,
      $.encode_field,
      $.plot_field,
    ),

    // mark: point, or mark: line { stroke_width: 2.0, },
    mark_field: $ => seq(
      "mark",
      ":",
      field("mark_type", $.mark_type),
      optional(seq(
        "{",
        optional(seq(
          $.plot_field,
          repeat(seq(",", $.plot_field)),
          optional(","),
        )),
        "}",
      )),
    ),

    mark_type: $ => choice("point", "line", "bar", "area", "rect", "tick"),

    // encode: { x: expr, y: expr, color: expr, ... },
    encode_field: $ => seq(
      "encode",
      ":",
      "{",
      optional(seq(
        $.encode_channel,
        repeat(seq(",", $.encode_channel)),
        optional(","),
      )),
      "}",
    ),

    encode_channel: $ => seq(
      field("channel", $.identifier),
      ":",
      field("value", $._expr),
    ),

    plot_field: $ => seq(
      field("name", $.identifier),
      ":",
      field("value", $._expr),
    ),

    // figure comparison = {
    //     plots: [curve_a, curve_b],
    //     title: "Side-by-side Comparison",
    // };
    figure_declaration: $ => seq(
      repeat($.attribute),
      optional($.visibility),
      "figure",
      field("name", $.identifier),
      "=",
      "{",
      optional(seq(
        $.figure_field,
        repeat(seq(",", $.figure_field)),
        optional(","),
      )),
      "}",
      ";",
    ),

    figure_field: $ => choice(
      $.figure_plots_field,
      $.figure_named_field,
    ),

    // plots: [name1, name2]
    figure_plots_field: $ => seq(
      "plots",
      ":",
      "[",
      optional(seq(
        $.identifier,
        repeat(seq(",", $.identifier)),
        optional(","),
      )),
      "]",
    ),

    // title: "...", or other key: value fields
    figure_named_field: $ => seq(
      field("name", $.identifier),
      ":",
      field("value", $._expr),
    ),

    // layer decay_with_points = {
    //     plots: [line_layer, point_layer],
    //     title: "Decay Curve with Points",
    // };
    layer_declaration: $ => seq(
      repeat($.attribute),
      optional($.visibility),
      "layer",
      field("name", $.identifier),
      "=",
      "{",
      optional(seq(
        $.layer_field,
        repeat(seq(",", $.layer_field)),
        optional(","),
      )),
      "}",
      ";",
    ),

    layer_field: $ => choice(
      $.layer_plots_field,
      $.layer_named_field,
    ),

    // plots: [name1, name2]
    layer_plots_field: $ => seq(
      "plots",
      ":",
      "[",
      optional(seq(
        $.identifier,
        repeat(seq(",", $.identifier)),
        optional(","),
      )),
      "]",
    ),

    // title: "...", or other key: value fields
    layer_named_field: $ => seq(
      field("name", $.identifier),
      ":",
      field("value", $._expr),
    ),

    assert_body: $ => choice(
      $.tolerance_assert,
      $._expr,
    ),

    // All three operands are full expressions. Tolerance is always absolute;
    // `%` is only the ordinary binary modulo operator inside an expression.
    tolerance_assert: $ => seq(
      field("actual", $._expr),
      "~=",
      field("expected", $._expr),
      "+/-",
      field("tolerance", $._expr),
    ),

    // ---------------------------------------------------------------
    // Type expressions
    // ---------------------------------------------------------------

    type_expr: $ => choice(
      $.indexed_type,
      $.constrained_type,
      $._type_expr_base,
    ),

    _type_expr_base: $ => choice(
      $.dimensionless,
      $.bool_type,
      $.int_type,
      $.datetime_type,
      $.complex_type,
      $.key_type,
      $.type_application,
      $.dim_expr,
    ),

    // Constrained type: Mass(min: 100 kg, max: 2000 kg)
    constrained_type: $ => seq(
      field("base", $._type_expr_base),
      $.type_constraints,
    ),

    type_constraints: $ => seq(
      "(",
      $.type_constraint,
      repeat(seq(",", $.type_constraint)),
      optional(","),
      ")",
    ),

    type_constraint: $ => seq(
      field("name", alias(choice("min", "max"), $.domain_bound_key)),
      ":",
      field("value", $._expr),
    ),

    domain_bound_key: _$ => choice("min", "max"),

    // Sort-aware generic type application: Vec3<Length, ECI>, Fixed<N + 1>,
    // module.Vec3<Length>. Semantic resolution classifies each argument as
    // Dim, Index, Nat, or Type after resolving the applied declaration.
    // Uses dynamic precedence to prefer type_application over parsing `<` as
    // a comparison operator when an identifier path is followed by `<` in type context.
    type_application: $ => prec.dynamic(2, seq(
      field("name", $.ident_path),
      "<",
      field("generic_arg", $.generic_arg),
      repeat(seq(",", field("generic_arg", $.generic_arg))),
      optional(","),
      ">",
    )),

    dimensionless: $ => "Dimensionless",
    bool_type: $ => "Bool",
    int_type: $ => "Int",
    // Bare `Datetime` (= Datetime<UTC>) or the built-in parameterized
    // form `Datetime<TT>`. The reference parser keeps this separate from
    // `type_application` (whose head is an `ident_path`, not a keyword).
    datetime_type: $ => seq(
      "Datetime",
      optional(seq(
        "<",
        field("type_arg", $.type_expr),
        repeat(seq(",", field("type_arg", $.type_expr))),
        optional(","),
        ">",
      )),
    ),

    // Built-in dimension-aware complex quantity: Complex<Length>, Complex<D / Time>.
    complex_type: $ => seq(
      "Complex",
      "<",
      field("dimension", $.generic_arg),
      ">",
    ),

    // Built-in index-key reflection type: Key<Maneuver>, Key<Fin(3)>,
    // Key<mission.Maneuver>, Key<I>. The sole argument must have sort
    // Index; bare `Key` is rejected.
    key_type: $ => seq(
      "Key",
      "<",
      field("index", $.generic_arg),
      ">",
    ),

    // Indexed type: Velocity[Maneuver], Dimensionless[Fin(3)], D[I]
    indexed_type: $ => seq(
      field("base", choice($.constrained_type, $._type_expr_base)),
      "[",
      $._index_expr,
      repeat(seq(",", $._index_expr)),
      optional(","),
      "]",
    ),

    // Nat values are never implicitly lifted into Index positions.
    _index_expr: $ => choice(
      $.finite_index,
      $.ident_path,
    ),

    finite_index: $ => seq(
      alias($._fin_keyword, "Fin"),
      "(",
      field("cardinality", $._nat_expr),
      ")",
    ),

    _nat_expr: $ => choice(
      $.nat_add_expr,
      $.nat_mul_expr,
      $.identifier,
      $.nat_literal,
    ),

    // Nat addition expression in index position: N + 1, M + N + 2, M * N + 1
    nat_add_expr: $ => prec.left(PREC.NAT_ADD, seq(
      field("left", choice($.identifier, $.nat_literal, $.nat_add_expr, $.nat_mul_expr)),
      "+",
      field("right", choice($.identifier, $.nat_literal, $.nat_mul_expr)),
    )),

    // Nat multiplication expression in index position: M * N, M * N * P, 2 * N
    nat_mul_expr: $ => prec.left(PREC.NAT_MUL, seq(
      field("left", choice($.identifier, $.nat_literal, $.nat_mul_expr)),
      "*",
      field("right", choice($.identifier, $.nat_literal)),
    )),

    // Integer literal in a type-level Nat expression.
    nat_literal: $ => /[0-9][0-9_]*/,

    // ---------------------------------------------------------------
    // Dimension expressions: Length, Length^2, Mass * Length / Time^2
    // ---------------------------------------------------------------

    dim_expr: $ => prec.right(PREC.MUL + 1, seq(
      $.dim_term,
      repeat(seq(choice("*", "/"), $.dim_term)),
    )),

    dim_term: $ => prec.right(PREC.POWER + 1, choice(
      seq($.ident_path, optional(seq("^", $.exponent))),
      seq("(", $.dim_expr, ")", optional(seq("^", $.exponent))),
    )),

    // Exponent on a dim/unit term: an integer (`^2`, `^-1`) or a
    // parenthesized rational (`^(1/2)`, `^(-1/2)`), per grammar.ebnf
    // `exponent`. Shared by dimension and unit expressions.
    exponent: $ => choice(
      $.signed_integer,
      seq("(", $.signed_integer, optional(seq("/", $.signed_integer)), ")"),
    ),

    signed_integer: $ => /-?[0-9][0-9_]*/,

    // ---------------------------------------------------------------
    // Unit expressions: m, m/s^2, kg * m / s^2, u.mile
    // ---------------------------------------------------------------

    // The optional `1/` prefix is the reciprocal shorthand (e.g. `1/min`);
    // the literal `1` numerator contributes nothing and only `1` is
    // allowed there (per grammar.ebnf `unit_expr`).
    unit_expr: $ => seq(
      optional(seq("1", "/")),
      $.unit_term,
      repeat(prec.dynamic(1, seq(choice("*", "/"), $.unit_term))),
    ),

    // A unit reference is a bare IDENT (local declaration, selective
    // import, or prelude unit) or `alias.unit` for a `pub` unit of a
    // module imported with an alias. Module aliases are single segments,
    // so at most one qualifier is allowed (per grammar.ebnf `unit_term`).
    unit_term: $ => prec.right(PREC.POWER + 1, choice(
      seq(
        optional(seq(field("module", $.identifier), ".")),
        field("name", $.identifier),
        optional(seq("^", $.exponent)),
      ),
      seq("(", $.unit_expr, ")", optional(seq("^", $.exponent))),
    )),

    // Unit definition in unit declaration: 1000 m, 1 kg * m / s^2
    // Also supports dynamic scale: (@rate) USD
    unit_def: $ => seq(
      field("scale", choice($.number, $.parenthesized_expr)),
      $.unit_expr,
    ),

    // ---------------------------------------------------------------
    // Expressions
    // ---------------------------------------------------------------

    _expr: $ => choice(
      $.binary_expr,
      $.unary_expr,
      $.convert_expr,
      $.if_expr,
      $.match_expr,
      $.for_expr,
      $.scan_expr,
      $.unfold_expr,
      $.key_form_expr,
      $.table_expr,
      $._postfix_expr,
    ),

    // Conversion: expr -> unit_expr, or timezone display conversion:
    // expr -> "Asia/Tokyo" (a string literal target selects the
    // timezone-display form, matching the reference parser).
    convert_expr: $ => prec.left(PREC.CONVERT, seq(
      field("value", $._expr),
      "->",
      field("target", choice($.unit_expr, $.string_literal)),
    )),

    binary_expr: $ => choice(
      prec.left(PREC.OR, seq(field("left", $._expr), "||", field("right", $._expr))),
      prec.left(PREC.AND, seq(field("left", $._expr), "&&", field("right", $._expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._expr), "==", field("right", $._expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._expr), "!=", field("right", $._expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._expr), "<", field("right", $._expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._expr), ">", field("right", $._expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._expr), "<=", field("right", $._expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._expr), ">=", field("right", $._expr))),
      prec.left(PREC.ADD, seq(field("left", $._expr), "+", field("right", $._expr))),
      prec.left(PREC.ADD, seq(field("left", $._expr), "-", field("right", $._expr))),
      prec.left(PREC.MUL, seq(field("left", $._expr), "*", field("right", $._expr))),
      prec.left(PREC.MUL, seq(field("left", $._expr), "/", field("right", $._expr))),
      prec.left(PREC.MUL, seq(field("left", $._expr), "%", field("right", $._expr))),
      prec.right(PREC.POWER, seq(field("left", $._expr), "^", field("right", $._expr))),
    ),

    unary_expr: $ => prec(PREC.UNARY, seq(
      field("operator", choice("-", "!")),
      field("operand", $._expr),
    )),

    if_expr: $ => prec.right(seq(
      "if",
      field("condition", $._expr),
      field("then", $.brace_body),
      "else",
      field("else", $.brace_body),
    )),

    // match @maneuver { Impulsive(delta_v: dv) => ..., Coasting => ... }
    match_expr: $ => seq(
      "match",
      field("scrutinee", $._expr),
      "{",
      optional(seq(
        $.match_arm,
        repeat(seq(",", $.match_arm)),
        optional(","),
      )),
      "}",
    ),

    match_arm: $ => seq(
      field("pattern", $.match_pattern),
      "=>",
      field("body", $._expr),
    ),

    // Constructor and index-label patterns are both syntactic paths here.
    // Name resolution decides whether `module.Pick(...)` is a constructor
    // or whether `module.Phase.Burn` is an index label.
    match_pattern: $ => seq(
      field("path", $.ident_path),
      optional(seq(
        "(",
        optional(seq(
          $.pattern_binding,
          repeat(seq(",", $.pattern_binding)),
          optional(","),
        )),
        ")",
      )),
    ),

    pattern_binding: $ => choice(
      // field_name: _  (wildcard)
      seq(field("name", $.identifier), ":", $.wildcard),
      // field_name: var_name  (bind field to variable)
      seq(field("name", $.identifier), ":", field("binding", $.identifier)),
    ),

    wildcard: $ => "_",

    // for m: Maneuver { ... }
    for_expr: $ => seq(
      "for",
      $.for_binding,
      repeat(seq(",", $.for_binding)),
      "{",
      optional(seq(
        "(",
        field("key_var", $.identifier),
        repeat1(seq(",", field("key_var", $.identifier))),
        ")",
        "=>",
      )),
      field("body", $._expr),
      "}",
    ),

    for_binding: $ => seq(
      field("var", $.identifier),
      ":",
      field("index", choice($.ident_path, $.finite_index)),
    ),

    // scan(source, init, |acc, val| body) -- accumulator scan (prefix scan)
    scan_expr: $ => seq(
      alias($._scan_keyword, "scan"),
      "(",
      field("source", $._expr),
      ",",
      field("init", $._expr),
      ",",
      "|",
      field("acc", $.identifier),
      ",",
      field("val", $.identifier),
      "|",
      field("body", $._expr),
      ")",
    ),

    // unfold(index, init, |prev_state, prev_i, i| body) -- unfold (anamorphism)
    unfold_expr: $ => seq(
      alias($._unfold_keyword, "unfold"),
      "(",
      field("axis", $.ident_path),
      ",",
      field("init", $._expr),
      ",",
      "|",
      field("prev_state", $.identifier),
      ",",
      field("prev_index", $.identifier),
      ",",
      field("index", $.identifier),
      "|",
      field("body", $._expr),
      ")",
    ),

    // Key introduction forms: key(Fin(8), 1), fin_key(Fin(8), @n),
    // floor_key(TimeStep, @t), ceil_key(TimeStep, @t),
    // nearest_key(TimeStep, @t). The first argument is an index reference
    // (a named index path or `Fin(N)`), not a value expression. Like
    // `scan`/`unfold`, the head spellings are contextual: they select this
    // form only as bare call heads immediately followed by `(`.
    key_form_expr: $ => seq(
      choice(
        alias($._key_keyword, "key"),
        alias($._fin_key_keyword, "fin_key"),
        alias($._floor_key_keyword, "floor_key"),
        alias($._ceil_key_keyword, "ceil_key"),
        alias($._nearest_key_keyword, "nearest_key"),
      ),
      "(",
      field("axis", choice($.ident_path, $.finite_index)),
      ",",
      field("value", $._expr),
      ")",
    ),

    finite_table_index: $ => seq(
      alias($._fin_keyword, "Fin"),
      "(",
      field("cardinality", $.nat_literal),
      ")",
    ),

    // Table expression: table[Index1, Fin(3)] { ... }
    // Fin cardinalities are concrete because table shape is parsed eagerly.
    table_expr: $ => seq(
      "table",
      "[",
      field("index", choice($.ident_path, $.finite_table_index)),
      repeat(seq(",", field("index", choice($.ident_path, $.finite_table_index)))),
      optional(","),
      "]",
      "{",
      $.table_body,
      "}",
    ),

    table_body: $ => choice(
      // 3D+: slice sections
      repeat1($.table_slice_section),
      // 1D or 2D: optional header + data rows
      $.table_single,
    ),

    table_slice_section: $ => seq(
      "[",
      $.table_slice_label,
      repeat(seq(",", $.table_slice_label)),
      "]",
      $.table_single,
    ),

    // Slice labels: `Index.Variant` (named axis) or `#N` (Fin axis).
    table_slice_label: $ => choice(
      $.qualified_variant,
      seq("#", $.nat_literal),
    ),

    table_single: $ => seq(
      optional($.table_header_row),
      repeat1($.table_data_row),
    ),

    // Header row now requires a leading `:` prefix.
    // Omitted when the column axis is Fin.
    table_header_row: $ => seq(
      ":",
      field("column", $.identifier),
      repeat(seq(",", field("column", $.identifier))),
      ";",
    ),

    // Data row: `Label: val, val, ...;` for named row axes, or
    // `val, val, ...;` for Fin row axes. A row with a single
    // value and no label also covers the 1D case.
    table_data_row: $ => seq(
      optional(seq(field("row_label", $.identifier), ":")),
      field("value", $._expr),
      repeat(seq(",", field("value", $._expr))),
      ";",
    ),

    // Postfix expressions: calls, field access, and index access.
    _postfix_expr: $ => choice(
      $.fn_call,
      $.struct_construction,
      $.field_access,
      $.index_access,
      $._primary_expr,
    ),

    field_access: $ => prec.left(PREC.POSTFIX, seq(
      field("object", choice(
        $.graph_ref,
        $.inline_dag_call,
        $.fn_call,
        $.struct_construction,
        $.index_access,
        $.parenthesized_expr,
        $.field_access,
      )),
      ".",
      field("field", $.identifier),
    )),

    index_access: $ => prec.left(PREC.POSTFIX, seq(
      field("object", $._expr),
      "[",
      $.index_arg,
      repeat(seq(",", $.index_arg)),
      "]",
    )),

    index_arg: $ => $._expr,

    // Maneuver.Departure or module.Maneuver.Departure.
    qualified_variant: $ => prec.left(seq(
      field("path", $.identifier),
      repeat1(seq(".", field("path", $.identifier))),
    )),

    // Function or constructor call. Bare and qualified callees share the
    // same syntactic path shape; argument form and semantic resolution decide
    // whether this is a built-in function call or constructor call.
    fn_call: $ => prec(PREC.CALL, seq(
      field("name", $.identifier),
      repeat(seq(".", field("path_segment", $.identifier))),
      // The turbofish carries dynamic precedence so that when both the
      // call reading and the (non-chaining in the reference grammar)
      // chained-comparison reading of `f<T>(...)` complete, GLR picks
      // the call.
      optional(prec.dynamic(2, seq(
        "<",
        field("generic_arg", $.generic_arg),
        repeat(seq(",", field("generic_arg", $.generic_arg))),
        optional(","),
        ">",
      ))),
      "(",
      optional(seq(
        $._expr,
        repeat(seq(",", $._expr)),
        optional(","),
      )),
      ")",
    )),

    // A generic argument shared by type applications, constructor calls, and
    // parsed function calls. Nat arguments admit literals, lexical names, `+`,
    // and `*`; bare names and name-only products can also parse as type
    // expressions and remain semantically ambiguous until declaration lookup.
    // Carries PREC.CALL so the reduce to `generic_arg` inside a fn_call
    // turbofish ties with (instead of statically losing to) the parallel
    // struct_construction turbofish's shift of `,`/`>` — the tie is declared
    // as a GLR conflict below.
    generic_arg: $ => prec(PREC.CALL, choice(
      $.finite_index,
      $.type_expr,
      $.nat_add_expr,
      $.nat_mul_expr,
      $.nat_literal,
    )),

    // Primary expressions.
    //
    // `qualified_variant` covers `IDENT.IDENT` in expression position
    // (variant ref or qualified const ref); the name resolver decides
    // which. Keeping it here avoids an LR(1) shift-reduce ambiguity
    // between `field_access` (which would need to reduce the leading
    // `IDENT` into `_primary_expr` first) and `fn_call` (which would
    // shift `.` waiting for `(`).
    _primary_expr: $ => choice(
      $.number,
      $.boolean,
      $.string_literal,
      $.unit_literal,
      $.graph_ref,
      $.inline_dag_call,
      $.map_literal,
      $.parenthesized_expr,
      $.qualified_variant,
      $.ident_path,
    ),

    // Unit-annotated literal: 400 km, 9.80665 m/s^2
    // Uses dynamic precedence to prefer unit_literal over bare number
    // when followed by an identifier in expression context.
    unit_literal: $ => prec.dynamic(1, seq(
      field("value", $.number),
      field("unit", $.unit_expr),
    )),

    // Bare graph reference: `@<name>`. Field projections like
    // `@orbit.altitude` are built atop this via the postfix `field_access`
    // rule, the same way a non-`@` expression handles `.field`.
    graph_ref: $ => seq(
      "@",
      field("name", $.identifier),
    ),

    // Inline DAG invocation: `@<name>(args).<out>` for same-file calls,
    // `@<name>(.<seg>)+ (args).<out>` for cross-file qualified calls.
    //
    // The shape is kept distinct from `graph_ref` so that `@a.b` (no
    // parens) falls through to `field_access(graph_ref(@a), b)` — the
    // GLR parser keeps both interpretations alive past `@a.b` and the
    // presence of `(args).<out>` is what forces the inline-DAG reading.
    //
    // What `@` enforces is semantic: the post-`@` expression must denote
    // a *node*, which is why the `.<output>` projection is mandatory.
    // Bare `@dag(args)` (no projection) is rejected for the same reason
    // a multi-segment `@module.dag(args)` is rejected — projection is
    // what turns the DAG instance into a node.
    inline_dag_call: $ => seq(
      "@",
      field("name", $.identifier),
      repeat(seq(".", field("path_segment", $.identifier))),
      field("args", $.include_param_bindings),
      ".",
      field("output", $.identifier),
    ),

    // TransferResult(dv1: @dv1, dv2: a + b) or module.TransferResult(...)
    struct_construction: $ => prec(PREC.CALL, seq(
      field("type", $.identifier),
      repeat(seq(".", field("path_segment", $.identifier))),
      // Dynamic precedence mirrors fn_call's turbofish (see there). Type and
      // constructor applications intentionally share `generic_arg` syntax.
      optional(prec.dynamic(2, seq(
        "<",
        field("generic_arg", $.generic_arg),
        repeat(seq(",", field("generic_arg", $.generic_arg))),
        optional(","),
        ">",
      ))),
      "(",
      $.field_init,
      repeat(seq(",", $.field_init)),
      optional(","),
      ")",
    )),

    field_init: $ => seq(
      field("name", $.identifier),
      ":",
      field("value", $._expr),
    ),

    // { Maneuver.Departure: 2.46 km/s, ... }
    // { (Maneuver.Departure, Phase.Burn): 2.46 km/s, ... }
    map_literal: $ => seq(
      "{",
      optional(seq(
        choice($.map_entry, $.tuple_map_entry),
        repeat(seq(",", choice($.map_entry, $.tuple_map_entry))),
        optional(","),
      )),
      "}",
    ),

    map_entry: $ => seq(
      field("key", $.qualified_variant),
      ":",
      field("value", $._expr),
    ),

    tuple_map_entry: $ => seq(
      "(",
      field("key", $.qualified_variant),
      repeat1(seq(",", field("key", $.qualified_variant))),
      optional(","),
      ")",
      ":",
      field("value", $._expr),
    ),

    // A brace-delimited body used by if/for (single expression)
    brace_body: $ => seq(
      "{",
      field("value", $._expr),
      "}",
    ),

    parenthesized_expr: $ => seq(
      "(",
      $._expr,
      ")",
    ),

    // ---------------------------------------------------------------
    // Terminals
    // ---------------------------------------------------------------

    // Numeric literal with underscores and scientific notation
    number: $ => /[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9]+)?/,

    boolean: $ => choice("true", "false"),

    string_literal: $ => /"[^"]*"/,

    identifier: $ => /[a-zA-Z][a-zA-Z0-9_]*/,

    line_comment: $ => token(seq("//", /.*/)),
  },
});
